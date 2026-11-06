package services

import (
	"context"
	"testing"

	"github.com/S0obi/kanopa/internal/ldapx"
)

func TestSuccessText(t *testing.T) {
	p := ConnectionParams{URL: "ldaps://ldap.example.org", Security: "ldaps", Bind: "simple", BindDN: "cn=admin,dc=example,dc=org"}
	got := successText(p, TestResult{ElapsedMs: 42, NamingContexts: []string{"dc=example,dc=org"}})
	want := "Bound as cn=admin,dc=example,dc=org in 42 ms over LDAPS. The server offers 1 naming context: dc=example,dc=org."
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}

	p = ConnectionParams{URL: "ldap://localhost", Security: "none", Bind: "anonymous"}
	got = successText(p, TestResult{ElapsedMs: 3, NamingContexts: []string{"dc=a", "dc=b"}})
	want = "Connected anonymously in 3 ms over an unencrypted link. The server offers 2 naming contexts: dc=a, dc=b."
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestTestReportsWordedFailure(t *testing.T) {
	s := newTestService(t)
	s.open = func(context.Context, ldapx.Params) (*ldapx.Session, error) {
		return nil, ldapx.Classify(ldapErr49(), ldapx.Op{BindDN: "cn=admin,dc=example,dc=org"})
	}
	res := s.Test(context.Background(), ConnectionParams{URL: "ldaps://h", Security: "ldaps", Bind: "simple", BindDN: "cn=admin,dc=example,dc=org"})
	if res.OK || res.Code != 49 || res.Title != "Bind refused." {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestInvalidURLIsAFailureNotAPanic(t *testing.T) {
	s := newTestService(t)
	res := s.Test(context.Background(), ConnectionParams{URL: "nope"})
	if res.OK || res.Message != ldapx.ErrInvalidURL.Error() {
		t.Fatalf("unexpected result %+v", res)
	}
}
