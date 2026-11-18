//go:build integration

package services

import (
	"context"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/testldap"
)

// A password reset, with and without "must change at next login" (pwdReset), against the test server's
// ppolicy overlay (see test/ldap/README.md for what the overlay does). pwdReset has to be written after the
// Password Modify: a password change clears it, or sets it under a policy that asks for it.

func resetChange(t *testing.T, d *DirectoryService, id, uid, password string, mustChange bool) EntryChange {
	t.Helper()
	dn := acctDN(uid)
	view := d.Entry(context.Background(), id, dn)
	if view.Failure != nil {
		t.Fatalf("read %s: %+v", uid, view.Failure)
	}
	pw := attrOf(view, "userPassword")
	attrs := []AttributeChange{{Name: "userPassword", Kind: "password", Before: pw.IDs, After: pw.IDs, Password: password}}
	if mustChange {
		attrs = append(attrs, AttributeChange{Name: "pwdReset", Kind: "text", Before: attrOf(view, "pwdReset").Values, After: []string{"TRUE"}})
	}
	return EntryChange{Op: opModify, DN: dn, Attributes: attrs}
}

func resetFlag(d *DirectoryService, id, uid string) string {
	return strings.Join(attrOf(d.Entry(context.Background(), id, acctDN(uid)), "pwdReset").Values, ",")
}

func TestResetPassword(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c := NewChangeService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)

	t.Run("the session knows the server has a password policy, and is not Active Directory", func(t *testing.T) {
		res := s.Connect(ctx, admin, "", false)
		if !res.OK || !res.Session.PasswordPolicy || res.Session.ActiveDirectory {
			t.Fatalf("session %+v", res.Session)
		}
	})

	t.Run("a reset that must be changed sets pwdReset after the password", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{resetChange(t, d, admin, "acct-ok", "Reset-Passw0rd1", true)})
		if r.Failure != nil || r.Applied != 1 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if got := resetFlag(d, admin, "acct-ok"); got != "TRUE" {
			t.Fatalf("pwdReset reads %q", got)
		}
		// The new password works.
		if code := bindCode(t, srv, acctDN("acct-ok"), "Reset-Passw0rd1"); code != 0 {
			t.Fatalf("bind with the new password: %d", code)
		}
	})

	t.Run("a reset that need not be changed clears an earlier flag", func(t *testing.T) {
		if got := resetFlag(d, admin, "acct-must-change"); got != "TRUE" {
			t.Fatalf("the fixture starts with the flag set: %q", got)
		}
		r := c.Apply(ctx, admin, []EntryChange{resetChange(t, d, admin, "acct-must-change", "Reset-Passw0rd2", false)})
		if r.Failure != nil || r.Applied != 1 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if got := resetFlag(d, admin, "acct-must-change"); got != "" {
			t.Fatalf("pwdReset reads %q", got)
		}
	})

	t.Run("a policy that asks for it sets pwdReset itself, and Kanopa sends nothing for it", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{resetChange(t, d, admin, "acct-expired", "Reset-Passw0rd3", false)})
		if r.Failure != nil || r.Applied != 1 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if got := resetFlag(d, admin, "acct-expired"); got != "TRUE" {
			t.Fatalf("pwdReset reads %q", got)
		}
	})

	t.Run("the preview shows pwdReset as part of the change", func(t *testing.T) {
		p := c.Preview(admin, []EntryChange{resetChange(t, d, admin, "acct-locked", "Reset-Passw0rd4", true)})
		if p.Failure != nil || !strings.Contains(p.LDIF, "pwdReset: TRUE") || strings.Contains(p.LDIF, "Reset-Passw0rd4") {
			t.Fatalf("preview %+v", p)
		}
	})

	t.Run("a new person with a password and must-change is created in one change", func(t *testing.T) {
		dn := "uid=mjackson,ou=accounts," + testldap.BaseDN
		text := func(name string, v ...string) AttributeChange {
			return AttributeChange{Name: name, Kind: "text", After: v}
		}
		r := c.Apply(ctx, admin, []EntryChange{{Op: opAdd, DN: dn, Attributes: []AttributeChange{
			text("objectClass", "inetOrgPerson", "organizationalPerson", "person", "top"), text("uid", "mjackson"), text("cn", "Mary Jackson"), text("sn", "Jackson"),
			{Name: "userPassword", Kind: "password", Password: "First-Passw0rd9"},
			text("pwdReset", "TRUE"),
		}}})
		if r.Failure != nil || r.Applied != 1 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if got := resetFlag(d, admin, "mjackson"); got != "TRUE" {
			t.Fatalf("pwdReset reads %q", got)
		}
		if code := bindCode(t, srv, dn, "First-Passw0rd9"); code != 0 {
			t.Fatalf("bind with the first password: %d", code)
		}
	})
}

func TestPasswordPolicy(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)
	reader := connectPrivate(t, s, srv, testldap.ReaderDN, testldap.ReaderPassword)

	for _, c := range []struct {
		who, uid string
		want     bool
		why      string
	}{
		{admin, "acct-expired", true, "strict asks for it"},
		{admin, "acct-ok", false, "until-unlocked does not"},
		{admin, "acct-expired-default", false, "names no policy: unknown, not required"},
		{admin, "acct-hidden-policy", false, "restricted does not ask"},
		{reader, "acct-expired", true, "a reader can read strict"},
		{reader, "acct-hidden-policy", false, "a reader cannot read restricted: unknown"},
	} {
		res := d.PasswordPolicy(ctx, c.who, acctDN(c.uid))
		if res.Failure != nil || res.MustChange != c.want {
			t.Errorf("%s (%s): %+v, want %v", c.uid, c.why, res, c.want)
		}
	}
}
