package services

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/S0obi/kanopa/internal/ldapx"
	"github.com/S0obi/kanopa/internal/ldif"
)

// ChangeService previews and applies the changes the UI holds. It keeps no change set itself:
// the UI sends the whole set with every call.
type ChangeService struct {
	log *slog.Logger
	dir *DirectoryService
}

// NewChangeService returns the change service over the connections cs opens.
func NewChangeService(log *slog.Logger, cs *ConnectionService) *ChangeService {
	if log == nil {
		log = slog.Default()
	}
	return &ChangeService{log: log, dir: NewDirectoryService(log, cs)}
}

// EntryChange is every pending change to one entry.
type EntryChange struct {
	DN         string            `json:"dn"`
	Title      string            `json:"title"` // shown as a comment in the LDIF
	Attributes []AttributeChange `json:"attributes"`
}

// AttributeChange is one attribute before and after the person's edits. Text and DN values are
// the values themselves; binary and password values are the ids the entry view gave them.
// After empty removes the attribute. Password, when set, is the new password.
type AttributeChange struct {
	Name     string   `json:"name"`
	Kind     string   `json:"kind"` // text | dn | binary | password
	Before   []string `json:"before"`
	After    []string `json:"after"`
	Password string   `json:"password"`
}

// PreviewResult is the change set as LDIF, as Kanopa will send it.
type PreviewResult struct {
	LDIF    string   `json:"ldif"`
	Entries int      `json:"entries"`
	Failure *Failure `json:"failure"`
}

// EntryResult is how applying one entry's changes went.
type EntryResult struct {
	DN      string   `json:"dn"`
	OK      bool     `json:"ok"`
	Failure *Failure `json:"failure"`
}

// ApplyResult lists the entries tried, in order. Apply stops at the first failure: the entries
// after it are not tried and keep their changes.
type ApplyResult struct {
	Results   []EntryResult `json:"results"`
	Applied   int           `json:"applied"`
	ElapsedMs int64         `json:"elapsedMs"`
	Failure   *Failure      `json:"failure"` // the connection itself: closed, read-only, lost
}

// Preview writes the change set as changetype: modify records, without contacting the server.
func (c *ChangeService) Preview(id string, changes []EntryChange) PreviewResult {
	l, f := c.dir.session(id)
	if f != nil {
		return PreviewResult{Failure: f}
	}
	var parts []string
	for _, ch := range changes {
		p, err := planEntry(l, ch, nil)
		if err != nil {
			return PreviewResult{Failure: &Failure{Title: "Change not valid.", Message: err.Error()}}
		}
		if p.empty() {
			continue
		}
		parts = append(parts, p.ldif(ch.Title))
	}
	return PreviewResult{LDIF: strings.Join(parts, "\n"), Entries: len(parts)}
}

// Apply sends the changes, one modify request per entry, in order. Before each entry it reads
// the entry again: when someone changed what the person edited meanwhile, it stops with code 122.
// Where the server supports it, an assertion control closes the gap between that read and the write.
func (c *ChangeService) Apply(ctx context.Context, id string, changes []EntryChange) ApplyResult {
	start := time.Now()
	out := ApplyResult{Results: []EntryResult{}}
	l, f := c.dir.session(id)
	if f != nil {
		out.Failure = f
		return out
	}
	if l.readOnly {
		out.Failure = &Failure{Title: "Read-only connection.",
			Message: "This connection is set to read-only, so Kanopa sends no changes over it. Edit the connection to allow changes."}
		return out
	}
	for _, ch := range changes {
		r := EntryResult{DN: ch.DN}
		if err := c.applyEntry(ctx, l, ch); err != nil {
			r.Failure = c.dir.fail(l, err)
			if r.Failure.Title == "Read failed." {
				r.Failure.Title = "Change not valid."
			}
			out.Results = append(out.Results, r)
			if r.Failure.Lost {
				out.Failure = r.Failure
			}
			c.log.Info("change refused", "id", id, "code", r.Failure.Code)
			break
		}
		r.OK = true
		out.Applied++
		out.Results = append(out.Results, r)
	}
	if out.Applied > 0 {
		l.forgetChildren() // descriptions and names shown in the tree may have changed
	}
	out.ElapsedMs = time.Since(start).Milliseconds()
	c.log.Info("changes applied", "id", id, "entries", out.Applied, "of", len(changes), "elapsed_ms", out.ElapsedMs)
	return out
}

func (c *ChangeService) applyEntry(ctx context.Context, l *liveSession, ch EntryChange) error {
	current, err := l.ReadEntry(ctx, ch.DN, l.referrals)
	if err != nil {
		return err
	}
	p, err := planEntry(l, ch, current)
	if err != nil {
		return err
	}
	if len(p.mods) > 0 {
		mods := make([]ldapx.Mod, len(p.mods))
		for i, m := range p.mods {
			mods[i] = m.Mod
		}
		assertion := ""
		if l.assertion {
			assertion = p.assertion
		}
		if err := l.Modify(ctx, ch.DN, mods, assertion); err != nil {
			return err
		}
	}
	if p.password != "" {
		return l.PasswordModify(ctx, ch.DN, p.password)
	}
	return nil
}

// conflict is the error for an entry that changed since the person read it.
func conflict() error {
	return &ldapx.Error{Code: 122, Name: ldapx.CodeName(122), Title: "Entry changed meanwhile.",
		Detail: "Someone changed this entry since you read it. Reload it, then make your changes again."}
}

// plannedMod is one modification, with what the LDIF preview says instead of hidden values.
type plannedMod struct {
	ldapx.Mod
	notes  []string
	hidden bool // the values are never written to the LDIF
}

// entryPlan is what Kanopa sends for one entry.
type entryPlan struct {
	dn        string
	mods      []plannedMod
	password  string // set with the Password Modify operation after mods
	assertion string // the filter the entry must still match
}

func (p *entryPlan) empty() bool { return len(p.mods) == 0 && p.password == "" }

func (p *entryPlan) ldif(title string) string {
	var comments []string
	if title != "" {
		comments = append(comments, title)
	}
	changes := make([]ldif.Change, 0, len(p.mods))
	for _, m := range p.mods {
		op := map[ldapx.ModOp]string{ldapx.ModAdd: "add", ldapx.ModDelete: "delete", ldapx.ModReplace: "replace"}[m.Op]
		vals := m.Values
		if m.hidden {
			vals = nil
		}
		changes = append(changes, ldif.Change{Op: op, Name: m.Attr, Values: vals, Notes: m.notes})
	}
	if p.password != "" {
		comments = append(comments, "The password is set with the Password Modify operation (RFC 3062); it is not shown.")
	}
	return ldif.Modify(p.dn, comments, changes)
}

// maxAssertedValues bounds how many values of one attribute the assertion filter lists.
const maxAssertedValues = 20

// planEntry turns one entry's changes into modifications. current is the entry as the server
// holds it now; nil for a preview, which then describes hidden values instead of sending them.
func planEntry(l *liveSession, ch EntryChange, current *ldapx.RawEntry) (*entryPlan, error) {
	p := &entryPlan{dn: ch.DN}
	var asserts []string
	for _, a := range ch.Attributes {
		if !attrName.MatchString(a.Name) {
			return nil, fmt.Errorf("%q is not an attribute name", a.Name)
		}
		def := l.schema.Attr(a.Name)
		// Without a schema, assume values can be compared: most attributes have an equality rule.
		comparable := def == nil || def.Equality != ""
		var now [][]byte
		if current != nil {
			now = rawValues(current, a.Name)
			if !sameValues(a.Kind, a.Before, now) {
				return nil, conflict()
			}
		}
		switch a.Kind {
		case "binary", "password":
			mods, pw, err := planHidden(l, a, def, comparable, now, current != nil)
			if err != nil {
				return nil, err
			}
			p.mods = append(p.mods, mods...)
			if pw != "" {
				p.password = pw
			}
			asserts = append(asserts, presence(a.Name, len(a.Before) > 0))
		default:
			if m := planText(a, comparable); m != nil {
				p.mods = append(p.mods, *m)
			}
			asserts = append(asserts, assertValues(a.Name, a.Before, comparable))
		}
	}
	if !p.empty() && len(asserts) > 0 {
		p.assertion = "(&" + strings.Join(asserts, "") + ")"
	}
	return p, nil
}

// planText compares text values exactly: adds only, removals only, or a replace for anything else.
func planText(a AttributeChange, comparable bool) *plannedMod {
	added := minus(a.After, a.Before)
	removed := minus(a.Before, a.After)
	mod := func(op ldapx.ModOp, vals []string) *plannedMod {
		return &plannedMod{Mod: ldapx.Mod{Op: op, Attr: a.Name, Values: toBytes(vals)}}
	}
	switch {
	case len(added) == 0 && len(removed) == 0:
		return nil
	case len(a.After) == 0:
		return mod(ldapx.ModDelete, nil)
	case len(a.Before) == 0:
		return mod(ldapx.ModAdd, a.After)
	case !comparable || (len(added) > 0 && len(removed) > 0):
		return mod(ldapx.ModReplace, a.After)
	case len(added) > 0:
		return mod(ldapx.ModAdd, added)
	default:
		return mod(ldapx.ModDelete, removed)
	}
}

// planHidden handles binary and password values, which the UI names by id. Binary values can only
// be removed; a password can also be set.
func planHidden(l *liveSession, a AttributeChange, def *ldapx.AttributeType, comparable bool, now [][]byte, live bool) ([]plannedMod, string, error) {
	if added := minus(a.After, a.Before); len(added) > 0 {
		return nil, "", fmt.Errorf("%s: Kanopa can only remove binary values", a.Name)
	}
	var mods []plannedMod
	removed := minus(a.Before, a.After)
	if a.Kind == "password" && a.Password != "" {
		if l.passwordModify && strings.EqualFold(canonical(a.Name, def), "userPassword") && len(removed) == 0 {
			return nil, a.Password, nil
		}
		// No Password Modify: the server stores what it is sent, and its policy may hash it.
		m := plannedMod{Mod: ldapx.Mod{Op: ldapx.ModReplace, Attr: a.Name, Values: [][]byte{[]byte(a.Password)}},
			notes: []string{"The new password is sent as typed; it is not shown."}, hidden: true}
		return append(mods, m), "", nil
	}
	if len(removed) == 0 {
		return nil, "", nil
	}
	noun := "binary value"
	if a.Kind == "password" {
		noun = "password value"
	}
	if len(a.After) == 0 {
		return append(mods, plannedMod{Mod: ldapx.Mod{Op: ldapx.ModDelete, Attr: a.Name},
			notes: []string{plural(len(a.Before), noun) + " removed, not shown"}}), "", nil
	}
	// Remove some values: by value when the server can compare them, else replace with the rest.
	var gone, kept [][]byte
	for _, v := range now {
		if slices.Contains(removed, valueID(v)) {
			gone = append(gone, v)
		} else {
			kept = append(kept, v)
		}
	}
	if live && len(gone) != len(removed) {
		return nil, "", conflict()
	}
	if comparable {
		return append(mods, plannedMod{Mod: ldapx.Mod{Op: ldapx.ModDelete, Attr: a.Name, Values: gone},
			notes: []string{plural(len(removed), noun) + " removed, not shown"}, hidden: true}), "", nil
	}
	m := plannedMod{Mod: ldapx.Mod{Op: ldapx.ModReplace, Attr: a.Name, Values: kept},
		notes: []string{plural(len(a.After), noun) + " kept, not shown"}, hidden: true}
	return append(mods, m), "", nil
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

func canonical(name string, def *ldapx.AttributeType) string {
	if def != nil && len(def.Names) > 0 {
		return def.Names[0]
	}
	return name
}

// assertValues is the filter for "the attribute still holds exactly these values" as far as a
// filter can say: each value present, or the attribute absent when it had none.
func assertValues(name string, before []string, comparable bool) string {
	if len(before) == 0 || !comparable || len(before) > maxAssertedValues {
		return presence(name, len(before) > 0)
	}
	var b strings.Builder
	for _, v := range before {
		b.WriteString("(" + name + "=" + ldapx.EscapeFilter(v) + ")")
	}
	return b.String()
}

func presence(name string, present bool) string {
	if present {
		return "(" + name + "=*)"
	}
	return "(!(" + name + "=*))"
}

// sameValues compares what the person read with what the server holds now.
func sameValues(kind string, before []string, now [][]byte) bool {
	if len(before) != len(now) {
		return false
	}
	have := make([]string, len(now))
	for i, v := range now {
		if kind == "binary" || kind == "password" {
			have[i] = valueID(v)
		} else {
			have[i] = string(v)
		}
	}
	return len(minus(before, have)) == 0 && len(minus(have, before)) == 0
}

func rawValues(e *ldapx.RawEntry, name string) [][]byte {
	for _, a := range e.Attributes {
		if strings.EqualFold(a.Name, name) {
			return a.Values
		}
	}
	return nil
}

// minus returns the values of a not in b, compared exactly.
func minus(a, b []string) []string {
	var out []string
	for _, v := range a {
		if !slices.Contains(b, v) {
			out = append(out, v)
		}
	}
	return out
}

func toBytes(vals []string) [][]byte {
	out := make([][]byte, len(vals))
	for i, v := range vals {
		out[i] = []byte(v)
	}
	return out
}

// attrName matches an attribute description: a name or OID, with options ("cn;lang-fr").
var attrName = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)+)(?:;[A-Za-z0-9-]+)*$`)
