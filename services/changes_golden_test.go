package services

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/ldapx"
)

// Golden files for change sets: each case writes the operations Kanopa plans
// (testdata/changes/<case>.ops) and the LDIF Review shows (<case>.ldif).
// Run `go test ./services -run TestChangeSetGolden -update` to rewrite them after a deliberate change.
var update = flag.Bool("update", false, "rewrite the golden files")

const adaDN = "uid=ada,ou=people,dc=example,dc=org"

var goldenCases = []struct {
	name           string
	passwordModify bool
	changes        []EntryChange
}{
	{name: "text-edits", changes: []EntryChange{{DN: adaDN, Title: "Ada Lovelace", Attributes: []AttributeChange{
		{Name: "title", Kind: "text", Before: []string{"Principal engineer"}, After: []string{"Chief engineer"}},
		{Name: "telephoneNumber", Kind: "text", Before: []string{"+41 44 555 01 10"}, After: []string{"+41 44 555 01 10", "+41 44 555 01 11"}},
		{Name: "cn", Kind: "text", Before: []string{"Ada Lovelace", "Ada King"}, After: []string{"Ada Lovelace"}},
		{Name: "description", Kind: "text", Before: []string{"Analyst"}},
		{Name: "noEq", Kind: "text", Before: []string{"a", "b"}, After: []string{"a"}},
	}}}},
	{name: "values-needing-base64", changes: []EntryChange{{DN: "uid=zoe.zurcher,ou=people,dc=example,dc=org", Attributes: []AttributeChange{
		{Name: "l", Kind: "text", After: []string{"Zürich"}},
		{Name: "description", Kind: "text", After: []string{" leading space", "a line that is long enough to be folded at seventy-six columns by the LDIF writer"}},
	}}}},
	{name: "hidden-values", passwordModify: true, changes: []EntryChange{{DN: adaDN, Title: "Ada Lovelace", Attributes: []AttributeChange{
		{Name: "jpegPhoto", Kind: "binary", Before: []string{"id1", "id2"}, After: []string{"id2"}},
		{Name: "userPassword", Kind: "password", Before: []string{"pw1"}, After: []string{"pw1"}, Password: "n3w-Passw0rd"},
	}}}},
	{name: "password-without-extension", changes: []EntryChange{{DN: adaDN, Attributes: []AttributeChange{
		{Name: "userPassword", Kind: "password", Before: []string{"pw1"}, After: []string{"pw1"}, Password: "n3w-Passw0rd"},
		{Name: "jpegPhoto", Kind: "binary", Before: []string{"id1"}},
	}}}},
	{name: "several-entries", changes: []EntryChange{
		{DN: adaDN, Title: "Ada Lovelace", Attributes: []AttributeChange{{Name: "title", Kind: "text", Before: []string{"Principal engineer"}, After: []string{"Fellow"}}}},
		{DN: "uid=alan,ou=people,dc=example,dc=org", Title: "Alan Turing", Attributes: []AttributeChange{{Name: "title", Kind: "text", Before: []string{"x"}, After: []string{"x"}}}},
		{DN: "cn=admins,ou=groups,dc=example,dc=org", Title: "admins", Attributes: []AttributeChange{
			{Name: "member", Kind: "dn", Before: []string{adaDN}, After: []string{adaDN, "uid=grace,ou=people,dc=example,dc=org"}}}},
	}},
}

func TestChangeSetGolden(t *testing.T) {
	for _, c := range goldenCases {
		t.Run(c.name, func(t *testing.T) {
			l := testSession()
			l.passwordModify = c.passwordModify
			var ops strings.Builder
			var ldif []string
			for _, ch := range c.changes {
				p, err := planEntry(l, ch, nil)
				if err != nil {
					t.Fatal(err)
				}
				fmt.Fprintf(&ops, "dn: %s\n%s", ch.DN, opsOf(p))
				if !p.empty() {
					ldif = append(ldif, p.ldif(ch.Title))
				}
			}
			golden(t, c.name+".ops", ops.String())
			golden(t, c.name+".ldif", strings.Join(ldif, "\n"))
			if strings.Contains(ops.String()+strings.Join(ldif, ""), "n3w-Passw0rd") {
				t.Fatal("a new password must never be written out")
			}
		})
	}
}

// opsOf lists the planned operations, one per line, hidden values by count only.
func opsOf(p *entryPlan) string {
	var b strings.Builder
	if p.empty() {
		b.WriteString("  (no change)\n")
	}
	names := map[ldapx.ModOp]string{ldapx.ModAdd: "add", ldapx.ModDelete: "delete", ldapx.ModReplace: "replace"}
	for _, m := range p.mods {
		vals := fmt.Sprintf("%q", stringsOf(m.Values))
		if m.hidden {
			vals = fmt.Sprintf("<%d hidden>", len(m.Values))
		}
		fmt.Fprintf(&b, "  %s %s %s\n", names[m.Op], m.Attr, vals)
	}
	if p.password != "" {
		b.WriteString("  password modify (RFC 3062)\n")
	}
	if p.assertion != "" {
		fmt.Fprintf(&b, "  assert %s\n", p.assertion)
	}
	return b.String()
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "changes", name)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path) //nolint:gosec // a fixed testdata path
	if err != nil {
		t.Fatalf("%v (run with -update to create it)", err)
	}
	if got != strings.ReplaceAll(string(want), "\r\n", "\n") {
		t.Errorf("%s differs from the golden file:\n--- got\n%s\n--- want\n%s", name, got, want)
	}
}
