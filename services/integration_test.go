//go:build integration

package services

import (
	"context"
	"regexp"
	"testing"

	"github.com/S0obi/kanopa/internal/testldap"
)

func TestServiceAgainstFixture(t *testing.T) {
	srv := testldap.Shared(t)
	s := newTestService(t)
	ctx := context.Background()

	ok := s.Test(ctx, ConnectionParams{URL: srv.LDAPSURL(), Security: "ldaps", Bind: "simple",
		BindDN: testldap.AdminDN, Password: testldap.AdminPassword, TimeoutSeconds: 5})
	want := regexp.MustCompile(`^Bound as cn=admin,dc=example,dc=org in \d+ ms over LDAPS\. The server offers 1 naming context: dc=example,dc=org\.$`)
	if !ok.OK || !want.MatchString(ok.Message) {
		t.Fatalf("unexpected %+v", ok)
	}

	bad := s.Test(ctx, ConnectionParams{URL: srv.LDAPURL(), Security: "starttls", Bind: "simple",
		BindDN: testldap.AdminDN, Password: "wrong", TimeoutSeconds: 5})
	if bad.OK || bad.Code != 49 {
		t.Fatalf("unexpected %+v", bad)
	}

	_ = s.ServiceShutdown()
	base := s.FetchBaseDN(ctx, ConnectionParams{URL: srv.LDAPURL(), Security: "none", Bind: "anonymous", TimeoutSeconds: 5})
	if !base.OK || base.BaseDN != testldap.BaseDN || base.Message != testldap.BaseDN {
		t.Fatalf("unexpected %+v", base)
	}
}

func TestConnectSavedConnection(t *testing.T) {
	srv := testldap.Shared(t)
	s, mem := newTestServiceWith(t)
	ctx := context.Background()

	c, err := s.Save(SaveRequest{Name: "Test directory", URL: srv.LDAPSURL(), Security: "ldaps", Bind: "simple",
		BindDN: testldap.AdminDN, Password: testldap.AdminPassword, SavePassword: true, TimeoutSeconds: 5})
	if err != nil {
		t.Fatal(err)
	}
	res := s.Connect(ctx, c.ID, "", false)
	if !res.OK || res.Session == nil {
		t.Fatalf("connect failed: %+v", res)
	}
	info := res.Session
	if info.BaseDN != testldap.BaseDN || info.BoundAs != testldap.AdminDN || info.Security != "LDAPS" || len(info.NamingContexts) != 1 {
		t.Fatalf("unexpected session %+v", info)
	}
	if got := s.List().Connections[0]; got.LastUsed == "" || got.LastError != "" {
		t.Fatalf("last used not recorded: %+v", got)
	}
	s.Disconnect(c.ID)

	// Not saved: Connect asks, then saves the password it is given when asked to.
	r := SaveRequest{ID: c.ID, Name: c.Name, URL: c.URL, Security: "ldaps", Bind: "simple", BindDN: testldap.AdminDN, TimeoutSeconds: 5}
	if _, err := s.Save(r); err != nil {
		t.Fatal(err)
	}
	if res := s.Connect(ctx, c.ID, "", false); res.Reason != ReasonNeedsPassword {
		t.Fatalf("want needsPassword, got %+v", res)
	}
	if res := s.Connect(ctx, c.ID, "wrong", true); res.Reason != ReasonBadPassword {
		t.Fatalf("want badPassword, got %+v", res)
	}
	if mem.Len() != 0 {
		t.Fatal("a refused password must not be saved")
	}
	if res := s.Connect(ctx, c.ID, testldap.AdminPassword, true); !res.OK {
		t.Fatalf("connect failed: %+v", res)
	}
	if pw, _ := mem.Get(c.ID); pw != testldap.AdminPassword || !s.List().Connections[0].SavePassword {
		t.Fatal("the password given at connect should now be saved")
	}
}
