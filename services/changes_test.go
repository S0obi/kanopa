package services

import (
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/ldapx"
)

func testSession() *liveSession {
	schema := ldapx.ParseSchema("cn=Subschema", []string{
		"( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )",
		"( 2.5.4.3 NAME 'cn' SUP name )",
		"( 2.5.4.12 NAME 'title' SUP name )",
		"( 0.9.2342.19200300.100.1.60 NAME 'jpegPhoto' SYNTAX 1.3.6.1.4.1.1466.115.121.1.28 )",
		"( 2.5.4.35 NAME 'userPassword' EQUALITY octetStringMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.40 )",
		"( 9.9 NAME 'noEq' SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )",
	}, nil)
	return &liveSession{schema: schema, passwordModify: true}
}

func TestPlanText(t *testing.T) {
	cases := []struct {
		before, after []string
		name          string
		want          string // op:values
	}{
		{[]string{"a"}, []string{"a"}, "cn", ""},
		{[]string{"a"}, []string{"a", "b"}, "cn", "add:b"},
		{[]string{"a", "b"}, []string{"a"}, "cn", "delete:b"},
		{[]string{"a"}, []string{"b"}, "cn", "replace:b"},
		{[]string{"Ada"}, []string{"ada"}, "cn", "replace:ada"},
		{[]string{"a"}, nil, "cn", "delete:"},
		{nil, []string{"x"}, "title", "add:x"},
		{[]string{"a", "b"}, []string{"a"}, "noEq", "replace:a"},
	}
	l := testSession()
	for _, c := range cases {
		p, err := planEntry(l, EntryChange{DN: "uid=ada", Attributes: []AttributeChange{{Name: c.name, Kind: "text", Before: c.before, After: c.after}}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		got := ""
		if len(p.mods) == 1 {
			m := p.mods[0]
			got = map[ldapx.ModOp]string{ldapx.ModAdd: "add", ldapx.ModDelete: "delete", ldapx.ModReplace: "replace"}[m.Op] + ":" + strings.Join(stringsOf(m.Values), ",")
		}
		if got != c.want {
			t.Errorf("%v → %v on %s: got %q, want %q", c.before, c.after, c.name, got, c.want)
		}
	}
}

func stringsOf(vals [][]byte) []string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = string(v)
	}
	return out
}

func TestAssertionFilter(t *testing.T) {
	p, err := planEntry(testSession(), EntryChange{DN: "uid=ada", Attributes: []AttributeChange{
		{Name: "cn", Kind: "text", Before: []string{"Ada (L)*"}, After: []string{"Ada"}},
		{Name: "title", Kind: "text", After: []string{"Analyst"}},
		{Name: "noEq", Kind: "text", Before: []string{"x"}, After: []string{"y"}},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := `(&(cn=Ada \28L\29\2a)(!(title=*))(noEq=*))`
	if p.assertion != want {
		t.Fatalf("assertion %s, want %s", p.assertion, want)
	}
}

func TestPlanHiddenValues(t *testing.T) {
	l := testSession()
	photo, other := []byte{0xff, 0xd8, 1}, []byte{0xff, 0xd8, 2}
	id1, id2 := valueID(photo), valueID(other)
	now := &ldapx.RawEntry{DN: "uid=ada", Attributes: []ldapx.RawAttribute{{Name: "jpegPhoto", Values: [][]byte{photo, other}}}}

	// jpegPhoto has no equality rule: removing one value replaces with the others.
	p, err := planEntry(l, EntryChange{DN: "uid=ada", Attributes: []AttributeChange{{Name: "jpegPhoto", Kind: "binary", Before: []string{id1, id2}, After: []string{id2}}}}, now)
	if err != nil || len(p.mods) != 1 || p.mods[0].Op != ldapx.ModReplace || string(p.mods[0].Values[0]) != string(other) {
		t.Fatalf("partial removal: %+v %v", p, err)
	}
	if _, err := planEntry(l, EntryChange{DN: "uid=ada", Attributes: []AttributeChange{{Name: "jpegPhoto", Kind: "binary", Before: []string{id1}, After: nil}}}, now); err == nil || !strings.Contains(err.Error(), "(122)") {
		t.Fatalf("a stale read must be a conflict, got %v", err)
	}
	if _, err := planEntry(l, EntryChange{DN: "uid=ada", Attributes: []AttributeChange{{Name: "jpegPhoto", Kind: "binary", Before: []string{id1, id2}, After: []string{id1, id2, "new"}}}}, nil); err == nil {
		t.Fatal("binary values can't be added")
	}

	// Password Modify for userPassword, never shown in the preview.
	pw := EntryChange{DN: "uid=ada", Title: "Ada Lovelace", Attributes: []AttributeChange{{Name: "userPassword", Kind: "password", Before: []string{"h"}, After: []string{"h"}, Password: "s3cret!"}}}
	p, _ = planEntry(l, pw, nil)
	if p.password != "s3cret!" || len(p.mods) != 0 || strings.Contains(p.ldif(pw.Title), "s3cret") {
		t.Fatalf("password modify: %+v", p)
	}
	l.passwordModify = false
	p, _ = planEntry(l, pw, nil)
	if p.password != "" || len(p.mods) != 1 || p.mods[0].Op != ldapx.ModReplace || strings.Contains(p.ldif(""), "s3cret") {
		t.Fatalf("fallback replace: %+v\n%s", p, p.ldif(""))
	}
}

func TestPlanRejectsOddNames(t *testing.T) {
	_, err := planEntry(testSession(), EntryChange{DN: "uid=ada", Attributes: []AttributeChange{{Name: "cn=*)(x", Kind: "text", After: []string{"a"}}}}, nil)
	if err == nil {
		t.Fatal("an attribute name with filter characters must be refused")
	}
}

func TestPreviewLDIF(t *testing.T) {
	s := newTestService(t)
	l := testSession()
	l.id = "c1"
	s.live.put(l)
	c := NewChangeService(nil, s)
	res := c.Preview("c1", []EntryChange{
		{DN: "uid=ada,dc=example,dc=org", Title: "Ada Lovelace", Attributes: []AttributeChange{{Name: "title", Kind: "text", Before: []string{"Analyst"}, After: []string{"Engineer"}}}},
		{DN: "uid=bob,dc=example,dc=org", Attributes: []AttributeChange{{Name: "title", Kind: "text", Before: []string{"x"}, After: []string{"x"}}}},
	})
	want := "# Ada Lovelace\ndn: uid=ada,dc=example,dc=org\nchangetype: modify\nreplace: title\ntitle: Engineer\n-\n"
	if res.Failure != nil || res.Entries != 1 || res.LDIF != want {
		t.Fatalf("preview %+v", res)
	}
	l.readOnly = true
	if r := c.Apply(t.Context(), "c1", nil); r.Failure == nil || r.Failure.Title != "Read-only connection." {
		t.Fatalf("read-only must refuse: %+v", r)
	}
}

func TestCloseGuard(t *testing.T) {
	closed := 0
	a := NewAppService(func() { closed++ })
	if a.ShouldBlockClose() {
		t.Fatal("nothing pending")
	}
	a.SetPendingChanges(2)
	if !a.ShouldBlockClose() {
		t.Fatal("pending changes block the close")
	}
	a.CloseAnyway()
	if closed != 1 || a.ShouldBlockClose() {
		t.Fatal("close anyway closes and stops blocking")
	}
}
