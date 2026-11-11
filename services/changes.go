package services

import (
	"context"
	"errors"
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
	Title      string            `json:"title"`  // shown as a comment in the LDIF
	Op         string            `json:"op"`     // modify (or empty) | add | delete | rename
	NewRDN     string            `json:"newRdn"` // rename: the new value of the naming attribute, as typed
	Attributes []AttributeChange `json:"attributes"`
}

// AttributeChange is one attribute before and after the person's edits. Text and DN values are
// the values themselves; binary and password values are the ids the entry view gave them.
// After empty removes the attribute. Password, when set, is the new password.
//
// A change can instead name values to add and remove (membership): Add and Remove, with Before
// and After empty. Values to remove must still be there; values already there are not added again.
type AttributeChange struct {
	Name     string   `json:"name"`
	Kind     string   `json:"kind"` // text | dn | binary | password
	Before   []string `json:"before"`
	After    []string `json:"after"`
	Password string   `json:"password"`
	Add      []string `json:"add"`
	Remove   []string `json:"remove"`
}

// delta reports whether the change names values to add and remove rather than a whole new set.
func (a AttributeChange) delta() bool { return len(a.Add)+len(a.Remove) > 0 }

// PreviewResult is the change set as LDIF, as Kanopa will send it.
type PreviewResult struct {
	LDIF    string   `json:"ldif"`
	Entries int      `json:"entries"`
	Failure *Failure `json:"failure"`
}

// EntryResult is how applying one entry's changes went.
type EntryResult struct {
	Index   int       `json:"index"` // the change's position in the set the UI sent
	Op      string    `json:"op"`    // modify | add | delete | rename
	DN      string    `json:"dn"`    // where it applied: for a rename, the new DN
	OK      bool      `json:"ok"`
	Node    *TreeNode `json:"node"` // the entry as the tree shows it now; nil when it could not be read again
	Failure *Failure  `json:"failure"`
}

// ApplyResult lists the changes tried, in the order they were sent (see orderChanges). Apply
// stops at the first failure: the changes after it are not tried and stay pending.
type ApplyResult struct {
	Results   []EntryResult `json:"results"`
	Applied   int           `json:"applied"`
	ElapsedMs int64         `json:"elapsedMs"`
	Failure   *Failure      `json:"failure"` // the connection itself: closed, read-only, lost
}

// Preview writes the change set as LDIF records in the order Apply sends them, without
// contacting the server.
func (c *ChangeService) Preview(id string, changes []EntryChange) PreviewResult {
	l, f := c.dir.session(id)
	if f != nil {
		return PreviewResult{Failure: f}
	}
	steps, err := l.orderChanges(changes)
	if err != nil {
		return PreviewResult{Failure: &Failure{Title: "Change not valid.", Message: err.Error()}}
	}
	var parts []string
	for _, s := range steps {
		text, err := previewStep(l, s)
		if err != nil {
			return PreviewResult{Failure: &Failure{Title: "Change not valid.", Message: err.Error()}}
		}
		if text != "" {
			parts = append(parts, text)
		}
	}
	return PreviewResult{LDIF: strings.Join(parts, "\n"), Entries: len(parts)}
}

// orderChanges orders the change set for this connection, refusing to rename or delete the
// base DN or a naming context.
func (l *liveSession) orderChanges(changes []EntryChange) ([]step, error) {
	steps, err := orderChanges(changes)
	if err != nil {
		return nil, err
	}
	for _, s := range steps {
		if (s.op == opRename || s.op == opDelete) && l.isRoot(s.dn) {
			return nil, fmt.Errorf("%s is a naming context; Kanopa doesn't %s it", s.dn, s.op)
		}
	}
	return steps, nil
}

func previewStep(l *liveSession, s step) (string, error) {
	var comments []string
	if s.ch.Title != "" {
		comments = append(comments, s.ch.Title)
	}
	switch s.op {
	case opDelete:
		return ldif.Delete(s.dn, comments), nil
	case opRename:
		return ldif.ModRDN(s.dn, comments, s.newRDN), nil
	case opAdd:
		attrs, password, err := addAttributes(l, s.ch)
		if err != nil {
			return "", err
		}
		var notes []string
		if password != "" {
			notes = append(notes, "userPassword is set with the Password Modify operation (RFC 3062) after the add; it is not shown.")
		}
		shown := make([]ldif.Attribute, 0, len(attrs))
		for _, a := range attrs {
			if strings.Contains(strings.ToLower(a.Name), "password") {
				notes = append(notes, a.Name+" is sent as typed; it is not shown.")
				continue
			}
			shown = append(shown, ldif.Attribute{Name: a.Name, Values: a.Values})
		}
		return ldif.Add(s.dn, comments, shown, notes), nil
	}
	p, err := planEntry(l, s.ch, nil)
	if err != nil || p.empty() {
		return "", err
	}
	return p.ldif(s.ch.Title), nil
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
	steps, err := l.orderChanges(changes)
	if err != nil {
		out.Failure = &Failure{Title: "Change not valid.", Message: err.Error()}
		return out
	}
	for _, s := range steps {
		r := EntryResult{Index: s.index, Op: s.op, DN: s.dn}
		if err := c.applyStep(ctx, l, s); err != nil {
			r.Failure = c.dir.fail(l, err)
			if r.Failure.Title == "Read failed." {
				r.Failure.Title = "Change not valid."
			}
			out.Results = append(out.Results, r)
			if r.Failure.Lost {
				out.Failure = r.Failure
			}
			c.log.Info("change refused", "id", id, "op", s.op, "code", r.Failure.Code)
			break
		}
		r.OK = true
		out.Applied++
		if s.op == opRename {
			r.DN = s.newDN
		}
		// The tree lists entries by parent: an add, delete or rename changes the parent's list.
		if s.op != opModify {
			l.forgetChildren(parentOf(s.dn))
		}
		// The tree shows a description or name that may have changed: read the entry once more.
		if s.op != opDelete {
			if raw, err := l.ReadEntry(ctx, r.DN, l.referrals); err == nil {
				n := nodeOf(raw.Child())
				l.updateChild(n)
				r.Node = &n
			}
		}
		out.Results = append(out.Results, r)
	}
	out.ElapsedMs = time.Since(start).Milliseconds()
	c.log.Info("changes applied", "id", id, "entries", out.Applied, "of", len(changes), "elapsed_ms", out.ElapsedMs)
	return out
}

func (c *ChangeService) applyStep(ctx context.Context, l *liveSession, s step) error {
	switch s.op {
	case opDelete:
		return l.Delete(ctx, s.dn)
	case opRename:
		// Kanopa renames leaves only: an entry with entries below it would move them all, and every
		// reference to them would need updating too.
		if raw, err := l.ReadEntry(ctx, s.dn, l.referrals); err == nil {
			if c := raw.Child(); (c.HasSubordinates != nil && *c.HasSubordinates) || c.NumSubordinates > 0 {
				return &ldapx.Error{Code: 66, Name: ldapx.CodeName(66), Title: "Entry has children.", Lead: true,
					Detail: "Kanopa renames only entries without entries below them."}
			}
		}
		return l.Rename(ctx, s.dn, s.newRDN)
	case opAdd:
		attrs, password, err := addAttributes(l, s.ch)
		if err != nil {
			return err
		}
		if err := l.Add(ctx, s.dn, attrs); err != nil {
			return err
		}
		if password != "" {
			return l.PasswordModify(ctx, s.dn, password)
		}
		return nil
	}
	return c.applyEntry(ctx, l, s.ch)
}

// addAttributes lists a new entry's attributes as Add sends them. A password goes through
// Password Modify after the add when the server offers it, so the server hashes it.
func addAttributes(l *liveSession, ch EntryChange) (attrs []ldapx.RawAttribute, password string, err error) {
	if _, _, _, err := ldapx.SplitDN(ch.DN); err != nil {
		return nil, "", err
	}
	for _, a := range ch.Attributes {
		if !attrName.MatchString(a.Name) {
			return nil, "", fmt.Errorf("%q is not an attribute name", a.Name)
		}
		switch a.Kind {
		case "binary":
			return nil, "", fmt.Errorf("%s: Kanopa can't add binary values yet", a.Name)
		case "password":
			if a.Password == "" {
				continue
			}
			if l.passwordModify && strings.EqualFold(canonical(a.Name, l.schema.Attr(a.Name)), "userPassword") {
				password = a.Password
				continue
			}
			attrs = append(attrs, ldapx.RawAttribute{Name: a.Name, Values: [][]byte{[]byte(a.Password)}})
		default:
			if vals := nonBlank(a.After); len(vals) > 0 {
				attrs = append(attrs, ldapx.RawAttribute{Name: a.Name, Values: toBytes(vals)})
			}
		}
	}
	return attrs, password, nil
}

func nonBlank(vals []string) []string {
	var out []string
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			out = append(out, v)
		}
	}
	return out
}

// parentOf is the DN of an entry's parent, as written.
func parentOf(dn string) string {
	parts := rdns(dn)
	if len(parts) < 2 {
		return ""
	}
	return strings.Join(parts[1:], ",")
}

func (c *ChangeService) applyEntry(ctx context.Context, l *liveSession, ch EntryChange) error {
	current, err := l.ReadEntry(ctx, ch.DN, l.referrals)
	if err != nil {
		return err
	}
	if changed := changedSince(ch, current); len(changed) > 0 {
		return ldapx.Conflict(changed)
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
			return nameConflict(ctx, l, ch, err)
		}
	}
	if p.password != "" {
		return l.PasswordModify(ctx, ch.DN, p.password)
	}
	return nil
}

// changedSince lists the edited attributes whose values on the server (current) are no longer
// the ones the person read, in the order of the change.
func changedSince(ch EntryChange, current *ldapx.RawEntry) []string {
	var out []string
	for _, a := range ch.Attributes {
		now := rawValues(current, a.Name)
		if a.delta() {
			for _, v := range a.Remove {
				if !holds(a.Kind, now, v) {
					out = append(out, a.Name)
					break
				}
			}
			continue
		}
		if !sameValues(a.Kind, a.Before, now) {
			out = append(out, a.Name)
		}
	}
	return out
}

// holds reports whether the values include v; DNs compare as names, not as text.
func holds(kind string, values [][]byte, v string) bool {
	for _, have := range values {
		if string(have) == v || (kind == "dn" && ldapx.SameDN(string(have), v)) {
			return true
		}
	}
	return false
}

// nameConflict turns the server's assertion failure (122) into one that names the attributes
// that changed between Kanopa's read and the write, by reading the entry once more.
func nameConflict(ctx context.Context, l *liveSession, ch EntryChange, err error) error {
	var le *ldapx.Error
	if !errors.As(err, &le) || le.Code != 122 {
		return err
	}
	if now, rerr := l.ReadEntry(ctx, ch.DN, l.referrals); rerr == nil {
		return ldapx.Conflict(changedSince(ch, now))
	}
	return ldapx.Conflict(nil)
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
			now = rawValues(current, a.Name) // applyEntry checked them against what was read
		}
		switch {
		case a.delta():
			if a.Kind == "binary" || a.Kind == "password" {
				return nil, fmt.Errorf("%s: values to add or remove must be text or DNs", a.Name)
			}
			var add []string
			for _, v := range a.Add {
				// Already there (someone else added it): nothing to send for it.
				if current == nil || !holds(a.Kind, now, v) {
					add = append(add, v)
				}
			}
			if len(a.Remove) > 0 {
				p.mods = append(p.mods, plannedMod{Mod: ldapx.Mod{Op: ldapx.ModDelete, Attr: a.Name, Values: toBytes(a.Remove)}})
				for _, v := range a.Remove {
					asserts = append(asserts, "("+a.Name+"="+ldapx.EscapeFilter(v)+")")
				}
			}
			if len(add) > 0 {
				p.mods = append(p.mods, plannedMod{Mod: ldapx.Mod{Op: ldapx.ModAdd, Attr: a.Name, Values: toBytes(add)}})
			}
		case a.Kind == "binary" || a.Kind == "password":
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
		// Password Modify replaces every value of userPassword, so the removed ones go too.
		if l.passwordModify && strings.EqualFold(canonical(a.Name, def), "userPassword") {
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
		return nil, "", ldapx.Conflict([]string{a.Name})
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
