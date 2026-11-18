//go:build integration

package services

import (
	"errors"
	"strings"
	"testing"

	"github.com/go-ldap/ldap/v3"

	"github.com/S0obi/kanopa/internal/testldap"
)

// What the test server's ppolicy overlay does, pinned. The account status banner and the password
// reset (features 02 and 03 of the 0.2 plan) rely on each of these. If a newer OpenLDAP changes one,
// this test fails and the plan has to be looked at again. The results are written up in test/ldap/README.md.

const relaxRules = "1.3.6.1.4.1.4203.666.5.12"

type ppConn struct {
	t    *testing.T
	conn *ldap.Conn
}

func dialAs(t *testing.T, srv *testldap.Server, dn, password string) *ppConn {
	t.Helper()
	c, err := ldap.DialURL(srv.LDAPURL())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	if err := c.Bind(dn, password); err != nil {
		t.Fatalf("bind as %s: %v", dn, err)
	}
	return &ppConn{t, c}
}

func acctDN(uid string) string { return "uid=" + uid + ",ou=accounts," + testldap.BaseDN }

// state reads the password state of an account the way Kanopa will: by naming the operational attributes.
func (p *ppConn) state(uid string) map[string]string {
	p.t.Helper()
	res, err := p.conn.Search(ldap.NewSearchRequest(acctDN(uid), ldap.ScopeBaseObject, ldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)",
		[]string{"pwdAccountLockedTime", "pwdReset", "pwdChangedTime", "pwdPolicySubentry"}, nil))
	if err != nil {
		p.t.Fatalf("read %s: %v", uid, err)
	}
	out := map[string]string{}
	for _, a := range res.Entries[0].Attributes {
		out[a.Name] = a.Values[0]
	}
	return out
}

func (p *ppConn) modify(uid string, relax bool, build func(*ldap.ModifyRequest)) error {
	var controls []ldap.Control
	if relax {
		controls = append(controls, ldap.NewControlString(relaxRules, true, ""))
	}
	req := ldap.NewModifyRequest(acctDN(uid), controls)
	build(req)
	return p.conn.Modify(req)
}

func (p *ppConn) setPassword(uid, password string) {
	p.t.Helper()
	if _, err := p.conn.PasswordModify(ldap.NewPasswordModifyRequest(acctDN(uid), "", password)); err != nil {
		p.t.Fatalf("password modify %s: %v", uid, err)
	}
}

func bindCode(t *testing.T, srv *testldap.Server, dn, password string) uint16 {
	t.Helper()
	c, err := ldap.DialURL(srv.LDAPURL())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	err = c.Bind(dn, password)
	if err == nil {
		return 0
	}
	var le *ldap.Error
	if !errors.As(err, &le) {
		t.Fatalf("bind as %s: %v", dn, err)
	}
	return le.ResultCode
}

func TestPpolicyFixture(t *testing.T) {
	srv := testldap.New(t)
	admin := dialAs(t, srv, testldap.AdminDN, testldap.AdminPassword)
	reader := dialAs(t, srv, testldap.ReaderDN, testldap.ReaderPassword)
	pwdFlag := func(v map[string]string) string { return v["pwdReset"] }

	t.Run("a reader sees each state, and the policy of those that name one", func(t *testing.T) {
		if got := reader.state("acct-locked"); got["pwdAccountLockedTime"] == "" || !strings.HasPrefix(got["pwdPolicySubentry"], "cn=until-unlocked,") {
			t.Fatalf("acct-locked: %v", got)
		}
		if got := reader.state("acct-admin-locked")["pwdAccountLockedTime"]; got != "000001010000Z" {
			t.Fatalf("an administrator's lock reads %q", got)
		}
		if got := pwdFlag(reader.state("acct-must-change")); got != "TRUE" {
			t.Fatalf("pwdReset reads %q", got)
		}
		if got := reader.state("acct-expired-default"); got["pwdChangedTime"] == "" || got["pwdPolicySubentry"] != "" {
			t.Fatalf("expired under the default names no policy: %v", got)
		}
		if got := reader.state("acct-ok"); len(got) != 1 || got["pwdPolicySubentry"] == "" {
			t.Fatalf("a healthy account shows only its policy: %v", got)
		}
	})

	t.Run("a reader reads a policy, except the restricted one", func(t *testing.T) {
		search := func(c *ppConn, cn string) error {
			_, err := c.conn.Search(ldap.NewSearchRequest("cn="+cn+",ou=policies,"+testldap.BaseDN, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", []string{"pwdMaxAge"}, nil))
			return err
		}
		if err := search(reader, "strict"); err != nil {
			t.Fatalf("strict: %v", err)
		}
		if err := search(reader, "restricted"); !ldap.IsErrorWithCode(err, ldap.LDAPResultNoSuchObject) {
			t.Fatalf("restricted should read as no such object for a reader: %v", err)
		}
		if err := search(admin, "restricted"); err != nil {
			t.Fatalf("the admin reads it: %v", err)
		}
	})

	// Fact 1: what the admin bind may write to the policy attributes.
	t.Run("the admin deletes the lock and writes pwdReset without the Relax control", func(t *testing.T) {
		if err := admin.modify("acct-locked", false, func(r *ldap.ModifyRequest) { r.Delete("pwdAccountLockedTime", nil) }); err != nil {
			t.Fatalf("unlock: %v", err)
		}
		if got := admin.state("acct-locked")["pwdAccountLockedTime"]; got != "" {
			t.Fatalf("still locked: %q", got)
		}
		if err := admin.modify("acct-ok", false, func(r *ldap.ModifyRequest) { r.Replace("pwdReset", []string{"TRUE"}) }); err != nil {
			t.Fatalf("pwdReset: %v", err)
		}
		if got := pwdFlag(admin.state("acct-ok")); got != "TRUE" {
			t.Fatalf("pwdReset reads %q", got)
		}
	})

	// Fact 2: who sets pwdReset on a reset.
	t.Run("a reset sets pwdReset by itself only under a policy with pwdMustChange", func(t *testing.T) {
		admin.setPassword("acct-expired", "Reset-Passw0rd1") // strict: pwdMustChange TRUE
		got := admin.state("acct-expired")
		if got["pwdReset"] != "TRUE" || got["pwdChangedTime"] == "20200101000000Z" {
			t.Fatalf("under strict: %v", got)
		}
		// until-unlocked has no pwdMustChange: the reset clears a flag that was there.
		admin.setPassword("acct-must-change", "Reset-Passw0rd2")
		if got := admin.state("acct-must-change"); got["pwdReset"] != "" || got["pwdChangedTime"] == "" {
			t.Fatalf("under until-unlocked: %v", got)
		}
	})

	// Fact 4: the order inside one change.
	t.Run("Password Modify first, then pwdReset: the flag stays", func(t *testing.T) {
		admin.setPassword("acct-ok", "Reset-Passw0rd3")
		if got := pwdFlag(admin.state("acct-ok")); got != "" {
			t.Fatalf("the password change should clear the flag: %q", got)
		}
		if err := admin.modify("acct-ok", false, func(r *ldap.ModifyRequest) { r.Replace("pwdReset", []string{"TRUE"}) }); err != nil {
			t.Fatal(err)
		}
		if got := pwdFlag(admin.state("acct-ok")); got != "TRUE" {
			t.Fatalf("the flag is lost: %q", got)
		}
		// The other order loses it, which is why Kanopa sends Password Modify first.
		admin.setPassword("acct-ok", "Reset-Passw0rd4")
		if got := pwdFlag(admin.state("acct-ok")); got != "" {
			t.Fatalf("Password Modify after pwdReset should have cleared it: %q", got)
		}
	})

	// Fact 3: a lock that has run out.
	t.Run("a lock stays on the entry after its duration, until the next good bind clears it", func(t *testing.T) {
		if got := reader.state("acct-lock-ended")["pwdAccountLockedTime"]; got != "20200101000000Z" {
			t.Fatalf("lock time %q", got)
		}
		if code := bindCode(t, srv, acctDN("acct-lock-ended"), testldap.PersonPassword); code != 0 {
			t.Fatalf("the lock ended, so the bind should work: %d", code)
		}
		// The first good bind after the lock ran out removes it. Until then the attribute is stale.
		if got := reader.state("acct-lock-ended")["pwdAccountLockedTime"]; got != "" {
			t.Fatalf("a good bind should clear a lock that has ended: %q", got)
		}
	})

	t.Run("what the server enforces", func(t *testing.T) {
		for _, c := range []struct {
			uid  string
			want uint16
			why  string
		}{
			{"acct-admin-locked", ldap.LDAPResultInvalidCredentials, "locked until someone unlocks it"},
			{"acct-expired-default", ldap.LDAPResultInvalidCredentials, "expired under the default policy"},
			{"acct-hidden-policy", ldap.LDAPResultInvalidCredentials, "expired under a policy nobody reads"},
		} {
			if got := bindCode(t, srv, acctDN(c.uid), testldap.PersonPassword); got != c.want {
				t.Errorf("%s (%s): bind code %d, want %d", c.uid, c.why, got, c.want)
			}
		}
	})

	t.Run("the shared people are not locked by wrong passwords", func(t *testing.T) {
		ada := "uid=ada,ou=people," + testldap.BaseDN
		for range 8 {
			bindCode(t, srv, ada, "wrong")
		}
		if code := bindCode(t, srv, ada, testldap.PersonPassword); code != 0 {
			t.Fatalf("ada is locked out: %d", code)
		}
	})
}
