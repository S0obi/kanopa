//go:build integration

package services

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/ldapx"
	"github.com/S0obi/kanopa/internal/testldap"
)

// connectPrivate opens a connection to a private fixture, as bindDN.
func connectPrivate(t *testing.T, s *ConnectionService, srv *testldap.Server, bindDN, password string) string {
	t.Helper()
	c, err := s.Save(SaveRequest{Name: "Private " + bindDN, URL: srv.LDAPSURL(), Security: "ldaps", Bind: "simple", BindDN: bindDN,
		Password: password, SavePassword: true, TimeoutSeconds: 5, PageSize: 500})
	if err != nil {
		t.Fatal(err)
	}
	if res := s.Connect(context.Background(), c.ID, "", false); !res.OK {
		t.Fatalf("connect: %+v", res)
	}
	return c.ID
}

func attrOf(v EntryView, name string) EntryAttribute {
	for _, a := range v.Attributes {
		if strings.EqualFold(a.Name, name) {
			return a
		}
	}
	return EntryAttribute{}
}

func TestApplyChanges(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c := NewChangeService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)
	ada := "uid=ada,ou=people," + testldap.BaseDN

	if l := s.live.get(admin); !l.assertion || !l.passwordModify {
		t.Fatalf("OpenLDAP offers the assertion control and Password Modify: %v %v", l.assertion, l.passwordModify)
	}

	before := d.Entry(ctx, admin, ada)
	if !slices.ContainsFunc(before.Allowed, func(a AllowedAttribute) bool { return a.Name == "displayName" && a.SingleValue }) ||
		slices.ContainsFunc(before.Allowed, func(a AllowedAttribute) bool { return a.Name == "jpegPhoto" || a.Name == "cn" }) {
		t.Fatalf("allowed %+v", before.Allowed)
	}
	photo := attrOf(before, "jpegPhoto")
	res := c.Apply(ctx, admin, []EntryChange{{DN: ada, Attributes: []AttributeChange{
		{Name: "title", Kind: "text", Before: attrOf(before, "title").Values, After: []string{"Chief engineer"}},
		{Name: "displayName", Kind: "text", After: []string{"Countess Lovelace"}},
		{Name: "jpegPhoto", Kind: "binary", Before: photo.IDs},
	}}})
	if res.Failure != nil || res.Applied != 1 || !res.Results[0].OK {
		t.Fatalf("apply %+v %+v", res, res.Results)
	}
	if n := res.Results[0].Node; n == nil || n.DN != ada || n.Type != "person" {
		t.Fatalf("the changed entry comes back for the tree: %+v", n)
	}
	after := d.Entry(ctx, admin, ada)
	if got := attrOf(after, "title").Values; len(got) != 1 || got[0] != "Chief engineer" {
		t.Fatalf("title %v", got)
	}
	if attrOf(after, "displayName").Values[0] != "Countess Lovelace" || attrOf(after, "jpegPhoto").Name != "" {
		t.Fatal("displayName added and jpegPhoto removed")
	}

	t.Run("stale read is a conflict", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{{DN: ada, Attributes: []AttributeChange{
			{Name: "title", Kind: "text", Before: []string{"Principal engineer"}, After: []string{"x"}}}}})
		want := "Assertion failed (122) — title changed on the server since you read it. Reload the entry, then make your changes again."
		if f := r.Results[0].Failure; f == nil || f.Code != 122 || f.Title != "Entry changed meanwhile." || f.Message != want {
			t.Fatalf("want 122 naming title: %+v", r.Results[0].Failure)
		}
	})

	t.Run("a refused assertion names what changed", func(t *testing.T) {
		// The server refused the write (122): someone changed title between Kanopa's read and its write.
		l := s.live.get(admin)
		ch := EntryChange{DN: ada, Attributes: []AttributeChange{
			{Name: "title", Kind: "text", Before: []string{"Principal engineer"}, After: []string{"x"}},
			{Name: "displayName", Kind: "text", Before: []string{"Countess Lovelace"}, After: nil},
		}}
		var le *ldapx.Error
		if err := nameConflict(ctx, l, ch, ldapx.Conflict(nil)); !errors.As(err, &le) || !strings.HasPrefix(le.Detail, "title changed on the server") {
			t.Fatalf("want title named, got %v", err)
		}
	})

	t.Run("the server enforces the assertion", func(t *testing.T) {
		l := s.live.get(admin)
		err := l.Modify(ctx, ada, []ldapx.Mod{{Op: ldapx.ModReplace, Attr: "title", Values: [][]byte{[]byte("y")}}}, "(title=Someone else)")
		var le *ldapx.Error
		if !errors.As(err, &le) || le.Code != 122 {
			t.Fatalf("want 122 from the server, got %v", err)
		}
	})

	t.Run("required attribute", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{{DN: ada, Attributes: []AttributeChange{
			{Name: "sn", Kind: "text", Before: []string{"Lovelace"}}}}})
		f := r.Results[0].Failure
		if f == nil || f.Code != 65 || f.Title != "Required attribute missing." || f.Message != "Object class violation (65) — inetOrgPerson requires the attribute sn." {
			t.Fatalf("want 65: %+v", f)
		}
	})

	t.Run("single value", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{{DN: ada, Attributes: []AttributeChange{
			{Name: "displayName", Kind: "text", Before: []string{"Countess Lovelace"}, After: []string{"Countess Lovelace", "Ada"}}}}})
		if f := r.Results[0].Failure; f == nil || f.Code != 19 {
			t.Fatalf("want 19: %+v", f)
		}
	})

	t.Run("stops at the first failure", func(t *testing.T) {
		grace := "uid=grace,ou=people," + testldap.BaseDN
		r := c.Apply(ctx, admin, []EntryChange{
			{DN: grace, Attributes: []AttributeChange{{Name: "description", Kind: "text", After: []string{"First"}}}},
			{DN: ada, Attributes: []AttributeChange{{Name: "sn", Kind: "text", Before: []string{"Lovelace"}}}},
			{DN: grace, Attributes: []AttributeChange{{Name: "roomNumber", Kind: "text", After: []string{"Never"}}}},
		})
		if r.Applied != 1 || len(r.Results) != 2 || r.Results[1].OK {
			t.Fatalf("results %+v", r.Results)
		}
		if attrOf(d.Entry(ctx, admin, grace), "roomNumber").Name != "" {
			t.Fatal("the entry after the failure must not be tried")
		}
	})

	t.Run("password modify", func(t *testing.T) {
		alan := "uid=alan,ou=people," + testldap.BaseDN
		pw := attrOf(d.Entry(ctx, admin, alan), "userPassword")
		r := c.Apply(ctx, admin, []EntryChange{{DN: alan, Attributes: []AttributeChange{
			{Name: "userPassword", Kind: "password", Before: pw.IDs, After: pw.IDs, Password: "new-Pa55word"}}}})
		if !r.Results[0].OK {
			t.Fatalf("password: %+v", r.Results[0].Failure)
		}
		ok := s.Test(ctx, ConnectionParams{URL: srv.LDAPSURL(), Security: "ldaps", Bind: "simple", BindDN: alan, Password: "new-Pa55word", TimeoutSeconds: 5})
		if !ok.OK {
			t.Fatalf("bind with the new password: %+v", ok)
		}
		if v := attrOf(d.Entry(ctx, admin, alan), "userPassword").Values[0]; !strings.HasPrefix(v, "{SSHA}") {
			t.Fatalf("the server should hash it: %s", v)
		}
	})

	t.Run("read-only account", func(t *testing.T) {
		reader := connectPrivate(t, s, srv, testldap.ReaderDN, testldap.ReaderPassword)
		r := c.Apply(ctx, reader, []EntryChange{{DN: ada, Attributes: []AttributeChange{
			{Name: "description", Kind: "text", After: []string{"Hi"}}}}})
		if f := r.Results[0].Failure; f == nil || f.Code != 50 || f.Title != "Not allowed." || !strings.HasPrefix(f.Message, "Insufficient access (50) — ") {
			t.Fatalf("want 50: %+v", f)
		}
	})
}
