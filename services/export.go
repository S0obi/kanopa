package services

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-ldap/ldap/v3"

	"github.com/S0obi/kanopa/internal/ldapx"
	"github.com/S0obi/kanopa/internal/ldif"
)

// Exporting writes an entry, or a branch, to an LDIF file. It runs as a job the page starts and
// polls: the file is written to a temporary file next to its target and renamed over it when
// done, so canceling or failing never touches a file the person chose to replace.

// ExportOptions is what the person chose to export.
type ExportOptions struct {
	// Subtree exports the entry and everything below it; otherwise the entry alone.
	Subtree bool `json:"subtree"`
	// Secrets includes password hashes and other secrets, which are left out by default.
	Secrets bool `json:"secrets"`
}

// Export job states.
const (
	ExportRunning  = "running"
	ExportDone     = "done"
	ExportCanceled = "canceled"
	ExportFailed   = "failed"
)

// ExportStatus is how an export is going, or how it ended.
type ExportStatus struct {
	Job     string `json:"job"`
	State   string `json:"state"` // running | done | canceled | failed
	Written int    `json:"written"`
	// Incomplete: the file was kept but does not hold everything; Reason says why.
	Incomplete bool   `json:"incomplete"`
	Reason     string `json:"reason"`
	// OutOfOrder: some entry came before its parent, so a tool that needs parents first may refuse the file.
	OutOfOrder bool `json:"outOfOrder"`
	// Referrals are the references to other servers the server returned and Kanopa did not follow.
	Referrals []string `json:"referrals"`
	Path      string   `json:"path"`
	Failure   *Failure `json:"failure"`
}

// secretAttrs are attributes that hold secrets whose names don't say "password".
var secretAttrs = map[string]bool{"unicodepwd": true, "dbcspwd": true, "supplementalcredentials": true,
	"ntpwdhistory": true, "lmpwdhistory": true, "krbprincipalkey": true, "krbextradata": true}

type exportJob struct {
	cancel context.CancelFunc
	mu     sync.Mutex
	st     ExportStatus
}

func (j *exportJob) set(f func(*ExportStatus)) {
	j.mu.Lock()
	defer j.mu.Unlock()
	f(&j.st)
}

func (j *exportJob) status() ExportStatus {
	j.mu.Lock()
	defer j.mu.Unlock()
	st := j.st
	st.Referrals = append([]string{}, st.Referrals...)
	return st
}

type exportJobs struct {
	mu   sync.Mutex
	next int
	m    map[string]*exportJob
}

func (e *exportJobs) add(path string) *exportJob {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.m == nil {
		e.m = map[string]*exportJob{}
	}
	for k, j := range e.m { // jobs that ended and were read are forgotten when the next one starts
		if j.status().State != ExportRunning {
			delete(e.m, k)
		}
	}
	e.next++
	id := fmt.Sprintf("export-%d", e.next)
	j := &exportJob{st: ExportStatus{Job: id, State: ExportRunning, Path: path, Referrals: []string{}}}
	e.m[id] = j
	return j
}

func (e *exportJobs) get(id string) *exportJob {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.m[id]
}

// StartExport starts writing dn (and, if chosen, everything below it) to the file at path, and
// returns at once. The status it returns has the job to poll with ExportProgress; when the export
// can't start (nothing to write to, no such connection), it carries the Failure instead.
func (d *DirectoryService) StartExport(id, dn, path string, opts ExportOptions) ExportStatus {
	failed := func(f *Failure) ExportStatus {
		return ExportStatus{State: ExportFailed, Path: path, Referrals: []string{}, Failure: f}
	}
	l, f := d.session(id)
	if f != nil {
		return failed(f)
	}
	if strings.TrimSpace(dn) == "" {
		return failed(&Failure{Title: "Nothing to export.", Message: "Choose an entry to export."})
	}
	if path == "" || !filepath.IsAbs(path) {
		return failed(&Failure{Title: "No file chosen.", Message: "Choose where to save the LDIF file."})
	}
	if st, err := os.Stat(path); err == nil && st.IsDir() {
		return failed(&Failure{Title: "Can't save there.", Message: path + " is a folder."})
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".kanopa-export-*.tmp")
	if err != nil {
		return failed(&Failure{Title: "Can't save there.", Message: fmt.Sprintf("Kanopa can't write in %s: %v", filepath.Dir(path), unwrapPath(err))})
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := d.exports.add(path)
	job.cancel = cancel
	go func() {
		defer cancel()
		d.runExport(ctx, l, job, tmp, dn, path, opts)
	}()
	return job.status()
}

// unwrapPath drops the file name from an os error, which the message already names.
func unwrapPath(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

// ExportProgress says how the export job is going. An unknown job has failed.
func (d *DirectoryService) ExportProgress(job string) ExportStatus {
	j := d.exports.get(job)
	if j == nil {
		return ExportStatus{Job: job, State: ExportFailed, Referrals: []string{},
			Failure: &Failure{Title: "Export not found.", Message: "Kanopa has no record of this export."}}
	}
	return j.status()
}

// CancelExport stops a running export and removes what it had written; nothing is left behind.
func (d *DirectoryService) CancelExport(job string) {
	if j := d.exports.get(job); j != nil && j.cancel != nil {
		j.cancel()
	}
}

// runExport writes the export into tmp, then renames it to path. It always ends the job.
func (d *DirectoryService) runExport(ctx context.Context, l *liveSession, job *exportJob, tmp *os.File, dn, path string, opts ExportOptions) {
	closed := false
	discard := func() {
		if !closed {
			_ = tmp.Close()
		}
		_ = os.Remove(tmp.Name())
	}
	fail := func(f *Failure) {
		discard()
		job.set(func(s *ExportStatus) { s.State, s.Failure = ExportFailed, f })
	}

	w := bufio.NewWriterSize(tmp, 256<<10)
	scope, ldapScope := "this entry only", ldapx.ScopeBase
	if opts.Subtree {
		scope, ldapScope = "this entry and everything below", ldapx.ScopeSubtree
	}
	if _, err := w.WriteString(ldif.Header(d.version, d.now(), dn, scope, opts.Secrets) + ldif.Separator); err != nil {
		fail(&Failure{Title: "Couldn't write the file.", Message: err.Error()})
		return
	}

	// The connection's paged searches run one at a time: the tree waits while this one reads.
	l.paged.Lock()
	defer l.paged.Unlock()

	seen := map[uint64]struct{}{}
	written, outOfOrder := 0, false
	var writeErr error
	end, err := l.Stream(ctx, dn, ldapScope, l.pageSize, func(e *ldap.Entry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Every entry but the first must come after its parent, or an import tool may refuse the file.
		if written > 0 {
			if _, ok := seen[ldapx.DNKey(ldapx.ParentDN(e.DN))]; !ok {
				outOfOrder = true
			}
		}
		seen[ldapx.DNKey(e.DN)] = struct{}{}
		if _, err := w.WriteString(ldif.Entry(e.DN, exportAttrs(e, l.schema, opts.Secrets)) + ldif.Separator); err != nil {
			writeErr = err
			return err
		}
		written++
		job.set(func(s *ExportStatus) { s.Written = written })
		return nil
	})

	switch {
	case errors.Is(err, context.Canceled) || ctx.Err() != nil:
		discard()
		job.set(func(s *ExportStatus) { s.State = ExportCanceled })
		return
	case writeErr != nil:
		fail(&Failure{Title: "Couldn't write the file.", Message: writeErr.Error()})
		return
	case err != nil && written == 0:
		fail(d.fail(l, err))
		return
	}

	incomplete, reason := false, ""
	switch {
	case err != nil:
		f := d.fail(l, err)
		incomplete, reason = true, strings.TrimSpace(f.Title+" "+f.Message)
	case end.Cut == ldapx.CutByServer:
		incomplete, reason = true, fmt.Sprintf("the server stopped after %s. Size limit exceeded (4)", entries(written))
	}
	if incomplete {
		if _, werr := w.WriteString(ldif.Incomplete(reason)); werr != nil {
			fail(&Failure{Title: "Couldn't write the file.", Message: werr.Error()})
			return
		}
	}
	if ferr := w.Flush(); ferr != nil {
		fail(&Failure{Title: "Couldn't write the file.", Message: ferr.Error()})
		return
	}
	closed = true
	if cerr := tmp.Close(); cerr != nil {
		fail(&Failure{Title: "Couldn't write the file.", Message: cerr.Error()})
		return
	}
	if rerr := os.Rename(tmp.Name(), path); rerr != nil {
		fail(&Failure{Title: "Couldn't save the file.", Message: fmt.Sprintf("Kanopa couldn't save %s: %v", path, unwrapPath(rerr))})
		return
	}
	d.log.Info("exported ldif", "id", l.id, "entries", written, "incomplete", incomplete, "subtree", opts.Subtree, "secrets", opts.Secrets)
	job.set(func(s *ExportStatus) {
		s.State, s.Incomplete, s.Reason, s.OutOfOrder = ExportDone, incomplete, reason, outOfOrder
		s.Referrals = append([]string{}, end.Referrals...)
	})
}

// exportAttrs lists the attributes of e to write: user attributes only, objectClass first, and
// without password hashes and other secrets unless asked for.
func exportAttrs(e *ldap.Entry, schema *ldapx.Schema, secrets bool) []ldif.Attribute {
	var out []ldif.Attribute
	for _, a := range e.Attributes {
		def := schema.Attr(a.Name)
		lower := strings.ToLower(a.Name)
		if def != nil && def.Operational() || def == nil && operationalAttrs[lower] {
			continue
		}
		if !secrets && (kindOf(a.Name, def) == "password" || secretAttrs[lower]) {
			continue
		}
		attr := ldif.Attribute{Name: a.Name, Values: a.ByteValues}
		if strings.EqualFold(a.Name, "objectClass") {
			out = append([]ldif.Attribute{attr}, out...)
			continue
		}
		out = append(out, attr)
	}
	return out
}

// ShowInFolder opens the folder that holds the file at path in the file manager.
func (a *AppService) ShowInFolder(path string) error {
	if a.cfg.OpenPath == nil || path == "" {
		return errors.New("Kanopa can't open the file manager here.")
	}
	dir := filepath.Dir(path)
	if err := a.cfg.OpenPath(dir); err != nil {
		a.cfg.Log.Warn("show in folder", "err", err)
		return fmt.Errorf("Kanopa couldn't open %s: %w", dir, err)
	}
	return nil
}

// entries counts entries in words: "1 entry", "500 entries".
func entries(n int) string {
	if n == 1 {
		return "1 entry"
	}
	return fmt.Sprintf("%d entries", n)
}
