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
	s := NewConnectionService(nil)
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

	base := s.FetchBaseDN(ctx, ConnectionParams{URL: srv.LDAPURL(), Security: "none", Bind: "anonymous", TimeoutSeconds: 5})
	if !base.OK || base.BaseDN != testldap.BaseDN || base.Message != testldap.BaseDN {
		t.Fatalf("unexpected %+v", base)
	}
}
