//go:build integration

package services

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/ldapx"
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

func TestDeletedWhileConnectingKeepsNoSession(t *testing.T) {
	srv := testldap.Shared(t)
	s := newTestService(t)
	c, err := s.Save(SaveRequest{Name: "Gone", URL: srv.LDAPSURL(), Security: "ldaps", Bind: "simple",
		BindDN: testldap.AdminDN, Password: testldap.AdminPassword, SavePassword: true, TimeoutSeconds: 5})
	if err != nil {
		t.Fatal(err)
	}
	real := s.open
	s.open = func(ctx context.Context, p ldapx.Params) (*ldapx.Session, error) {
		sess, err := real(ctx, p)
		_ = s.Delete(c.ID) // the person deletes it while the bind runs
		return sess, err
	}
	res := s.Connect(context.Background(), c.ID, "", false)
	if res.OK || res.Title != "Connection not found." {
		t.Fatalf("unexpected %+v", res)
	}
	n := s.live.len()
	if n != 0 {
		t.Fatal("no session should be kept for a deleted connection")
	}
}

// connectFixture saves and opens an admin connection to the shared fixture.
func connectFixture(t *testing.T, s *ConnectionService, referrals string) string {
	t.Helper()
	srv := testldap.Shared(t)
	c, err := s.Save(SaveRequest{Name: "Fixture", URL: srv.LDAPSURL(), Security: "ldaps", Bind: "simple", BindDN: testldap.AdminDN,
		Password: testldap.AdminPassword, SavePassword: true, TimeoutSeconds: 5, PageSize: 500, Referrals: referrals})
	if err != nil {
		t.Fatal(err)
	}
	if res := s.Connect(context.Background(), c.ID, "", false); !res.OK {
		t.Fatalf("connect: %+v", res)
	}
	return c.ID
}

func TestBrowseTheFixture(t *testing.T) {
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	id := connectFixture(t, s, "show")
	ctx := context.Background()

	roots := d.Roots(id)
	if roots.Failure != nil || len(roots.Nodes) != 2 || roots.Nodes[0].DN != testldap.BaseDN || roots.Nodes[1].Sub != "Schema" {
		t.Fatalf("roots %+v", roots)
	}

	top := d.Children(ctx, id, testldap.BaseDN, "")
	names := map[string]TreeNode{}
	for _, n := range top.Nodes {
		names[n.RDN] = n
	}
	if top.Total != 5 || names["ou=people"].Type != "ou" || names["ou=people"].Sub != "People and their login accounts" || !names["ou=people"].HasChildren {
		t.Fatalf("top level %+v", top)
	}
	if p := names["ou=partners"]; !p.Referral || p.HasChildren {
		t.Fatalf("the referral should show as an entry: %+v", p)
	}

	// 1,182 people in pages of 500, counted up front for "Show N more".
	first := d.Children(ctx, id, "ou=people,"+testldap.BaseDN, "")
	if len(first.Nodes) != 500 || first.More == "" || first.Total != 1182 {
		t.Fatalf("first page: %d nodes, more=%q, total=%d", len(first.Nodes), first.More, first.Total)
	}
	seen := len(first.Nodes)
	for more := first.More; more != ""; {
		p := d.Children(ctx, id, "ou=people,"+testldap.BaseDN, more)
		if p.Failure != nil {
			t.Fatal(p.Failure)
		}
		seen += len(p.Nodes)
		more = p.More
	}
	if seen != 1182 {
		t.Fatalf("paged through %d people", seen)
	}

	ada := d.Entry(ctx, id, "uid=ada,ou=people,"+testldap.BaseDN)
	if ada.Failure != nil || ada.Title != "Ada Lovelace" || ada.Type != "person" {
		t.Fatalf("ada %+v", ada.Failure)
	}
	by := map[string]EntryAttribute{}
	for _, a := range ada.Attributes {
		by[a.Name] = a
	}
	if by["manager"].Kind != "dn" || by["jpegPhoto"].Kind != "binary" || by["userPassword"].Kind != "password" {
		t.Fatalf("kinds from the server's schema: %+v", by)
	}
	if !strings.HasPrefix(by["userPassword"].Values[0], "{SSHA} hashed value · ") || !by["cn"].Required || !by["entryUUID"].Operational {
		t.Fatalf("flags: %+v", by)
	}
	if !strings.Contains(ada.LDIF, "jpegPhoto:: ") || strings.Contains(ada.LDIF, "entryUUID") {
		t.Fatal("LDIF")
	}

	groups := d.MemberOf(ctx, id, "uid=ada,ou=people,"+testldap.BaseDN)
	var got []string
	for _, g := range groups.Entries {
		got = append(got, g.Name)
	}
	if strings.Join(got, ",") != "admins,engineering,research" {
		t.Fatalf("member of %v", got)
	}

	if f := d.Entry(ctx, id, "uid=nobody,ou=people,"+testldap.BaseDN).Failure; f == nil || f.Code != 32 || f.Lost {
		t.Fatalf("missing entry: %+v", f)
	}
	if f := d.Ping(ctx, id); f != nil {
		t.Fatalf("ping %+v", f)
	}
}

func TestIgnoredReferralsAreLeftOut(t *testing.T) {
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	id := connectFixture(t, s, "ignore")
	for _, n := range d.Children(context.Background(), id, testldap.BaseDN, "").Nodes {
		if n.Referral {
			t.Fatalf("referral listed: %+v", n)
		}
	}
}

func TestLostConnection(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c, _ := s.Save(SaveRequest{Name: "Private", URL: srv.LDAPURL(), Security: "none", Bind: "anonymous", TimeoutSeconds: 3})
	_ = s.AllowUnencrypted(c.ID)
	if res := s.Connect(context.Background(), c.ID, "", false); !res.OK {
		t.Fatalf("connect: %+v", res)
	}
	if err := srv.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	f := d.Children(context.Background(), c.ID, testldap.BaseDN, "").Failure
	if f == nil || !f.Lost || !strings.HasSuffix(f.Message, "Server is unavailable (52)") {
		t.Fatalf("want a lost connection, got %+v", f)
	}
	if again := d.Entry(context.Background(), c.ID, testldap.BaseDN).Failure; again == nil || !again.Lost {
		t.Fatalf("the session should be gone: %+v", again)
	}
}
