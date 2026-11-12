package ldapx

import (
	"context"
	"testing"
	"time"

	"github.com/S0obi/kanopa/internal/fakeldap"
)

const testBase = "dc=example,dc=org"

// directory is a base, ou=people with n people, and ou=groups.
func directory(n int) []fakeldap.Entry {
	entries := []fakeldap.Entry{
		{DN: testBase, Attrs: map[string][]string{"objectClass": {"dcObject", "organization", "top"}, "dc": {"example"}}},
		{DN: "ou=people," + testBase, Attrs: map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"people"}}},
		{DN: "ou=groups," + testBase, Attrs: map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"groups"}}},
	}
	return append(entries, fakeldap.People(testBase, n)...)
}

// connect opens a session on the fake server the way Kanopa does: root DSE first, paging noted.
func connect(t *testing.T, srv *fakeldap.Server) (*Session, *RootDSE) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := Open(ctx, Params{URL: srv.URL(), Security: SecurityNone, Bind: BindAnonymous, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	dse, err := s.ReadRootDSE(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.NoPaging = dse.PagingKnownAbsent()
	return s, dse
}

func TestPagingIsDetectedFromTheRootDSE(t *testing.T) {
	for _, tc := range []struct {
		name   string
		opts   fakeldap.Options
		absent bool
	}{
		{"offered", fakeldap.Options{Paging: true}, false},
		{"not offered", fakeldap.Options{}, true},
		{"controls not published", fakeldap.Options{HideControls: true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := connect(t, fakeldap.Start(t, directory(1), tc.opts))
			if s.NoPaging != tc.absent {
				t.Fatalf("NoPaging = %v, want %v", s.NoPaging, tc.absent)
			}
		})
	}
}

func TestChildrenPagedReadsEverything(t *testing.T) {
	srv := fakeldap.Start(t, directory(1200), fakeldap.Options{Paging: true})
	s, _ := connect(t, srv)
	kids, cut, err := s.Children(context.Background(), "ou=people,"+testBase, 500, 20_000, ReferralsAsEntries)
	if err != nil || cut != NotCut || len(kids) != 1200 {
		t.Fatalf("got %d children, cut %v, err %v", len(kids), cut, err)
	}
	paged := 0
	for _, r := range srv.Requests() {
		if r.Paged {
			paged++
		}
	}
	if paged != 3 {
		t.Fatalf("%d paged requests, want 3 pages of up to 500", paged)
	}
}

func TestChildrenWithoutPagingIsOnePlainSearch(t *testing.T) {
	srv := fakeldap.Start(t, directory(1200), fakeldap.Options{})
	s, _ := connect(t, srv)
	kids, cut, err := s.Children(context.Background(), "ou=people,"+testBase, 500, 20_000, ReferralsAsEntries)
	if err != nil || cut != NotCut || len(kids) != 1200 {
		t.Fatalf("got %d children, cut %v, err %v", len(kids), cut, err)
	}
	for _, r := range srv.Requests() {
		if r.Paged {
			t.Fatalf("a server without paging was sent the paging control: %+v", r)
		}
	}
}

func TestChildrenKeepWhatAServerSizeLimitReturned(t *testing.T) {
	// No paging, and the server stops every search at 500.
	srv := fakeldap.Start(t, directory(1200), fakeldap.Options{SizeLimit: 500})
	s, _ := connect(t, srv)
	kids, cut, err := s.Children(context.Background(), "ou=people,"+testBase, 500, 20_000, ReferralsAsEntries)
	if err != nil {
		t.Fatalf("a size limit is not a failure: %v", err)
	}
	if cut != CutByServer || len(kids) != 500 {
		t.Fatalf("got %d children, cut %v; want 500 and CutByServer", len(kids), cut)
	}

	// The same on a server that pages, with a limit smaller than the page.
	srv = fakeldap.Start(t, directory(1200), fakeldap.Options{Paging: true, SizeLimit: 100})
	s, _ = connect(t, srv)
	kids, cut, err = s.Children(context.Background(), "ou=people,"+testBase, 500, 20_000, ReferralsAsEntries)
	if err != nil || cut != CutByServer || len(kids) != 100 {
		t.Fatalf("paged: got %d children, cut %v, err %v; want 100 and CutByServer", len(kids), cut, err)
	}
}

func TestChildrenStopAtKanopasOwnLimitWithoutPaging(t *testing.T) {
	srv := fakeldap.Start(t, directory(1200), fakeldap.Options{})
	s, _ := connect(t, srv)
	kids, cut, err := s.Children(context.Background(), "ou=people,"+testBase, 500, 100, ReferralsAsEntries)
	if err != nil || cut != CutByKanopa || len(kids) != 100 {
		t.Fatalf("got %d children, cut %v, err %v; want 100 and CutByKanopa", len(kids), cut, err)
	}
	// Exactly at the limit is not a cut.
	kids, cut, err = s.Children(context.Background(), "ou=people,"+testBase, 500, 1200, ReferralsAsEntries)
	if err != nil || cut != NotCut || len(kids) != 1200 {
		t.Fatalf("at the limit: got %d children, cut %v, err %v", len(kids), cut, err)
	}
}

func TestChildCountsAreOnlyKnownWhenTheServerSaysThem(t *testing.T) {
	bare := fakeldap.Start(t, directory(3), fakeldap.Options{Paging: true})
	s, _ := connect(t, bare)
	kids, _, err := s.Children(context.Background(), testBase, 500, 100, ReferralsAsEntries)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range kids {
		if k.HasSubordinates != nil || k.NumSubordinates != -1 {
			t.Fatalf("a bare server said nothing about %s, got %v / %d", k.DN, k.HasSubordinates, k.NumSubordinates)
		}
	}

	rich := fakeldap.Start(t, directory(3), fakeldap.Options{Paging: true, HasSubordinates: true, NumSubordinates: true})
	s, _ = connect(t, rich)
	kids, _, err = s.Children(context.Background(), testBase, 500, 100, ReferralsAsEntries)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range kids {
		if k.HasSubordinates == nil || k.NumSubordinates < 0 {
			t.Fatalf("expected counts for %s", k.DN)
		}
		if k.DN == "ou=people,"+testBase && (!*k.HasSubordinates || k.NumSubordinates != 3) {
			t.Fatalf("ou=people has 3 people: %v / %d", *k.HasSubordinates, k.NumSubordinates)
		}
	}
}
