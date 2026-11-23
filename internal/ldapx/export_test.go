package ldapx

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"

	"github.com/S0obi/kanopa/internal/fakeldap"
)

func collect(t *testing.T, s *Session, base string, scope, page int) ([]string, StreamEnd, error) {
	t.Helper()
	var dns []string
	end, err := s.Stream(context.Background(), base, scope, page, func(e *ldap.Entry) error {
		dns = append(dns, e.DN)
		return nil
	})
	return dns, end, err
}

func TestStreamReadsASubtreeAPageAtATime(t *testing.T) {
	srv := fakeldap.Start(t, directory(1200), fakeldap.Options{Paging: true})
	s, _ := connect(t, srv)
	dns, end, err := collect(t, s, "ou=people,"+testBase, ScopeSubtree, 500)
	if err != nil || end.Cut != NotCut || len(dns) != 1201 {
		t.Fatalf("got %d entries, cut %v, err %v; want 1201 (the OU and its 1200 people)", len(dns), end.Cut, err)
	}
	paged := 0
	for _, r := range srv.Requests() {
		if r.Paged {
			paged++
			if len(r.Attrs) != 1 || r.Attrs[0] != "*" {
				t.Fatalf("export asked for %v, want user attributes only", r.Attrs)
			}
		}
	}
	if paged != 3 {
		t.Fatalf("%d paged requests, want 3", paged)
	}
}

func TestStreamOfOneEntryIsABaseSearch(t *testing.T) {
	s, _ := connect(t, fakeldap.Start(t, directory(5), fakeldap.Options{Paging: true}))
	dns, _, err := collect(t, s, "ou=people,"+testBase, ScopeBase, 500)
	if err != nil || len(dns) != 1 || dns[0] != "ou=people,"+testBase {
		t.Fatalf("got %v, err %v", dns, err)
	}
}

func TestStreamWithoutPagingIsOnePlainSearch(t *testing.T) {
	srv := fakeldap.Start(t, directory(700), fakeldap.Options{})
	s, _ := connect(t, srv)
	dns, end, err := collect(t, s, testBase, ScopeSubtree, 500)
	if err != nil || end.Cut != NotCut || len(dns) != 703 {
		t.Fatalf("got %d entries, cut %v, err %v", len(dns), end.Cut, err)
	}
	for _, r := range srv.Requests() {
		if r.Paged {
			t.Fatalf("a server without paging was sent the paging control: %+v", r)
		}
	}
}

func TestStreamKeepsWhatAServerSizeLimitReturned(t *testing.T) {
	for name, opts := range map[string]fakeldap.Options{
		"plain":  {SizeLimit: 500},
		"paged":  {Paging: true, SizeLimit: 100},
		"paged2": {Paging: true, SizeLimit: 499},
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := connect(t, fakeldap.Start(t, directory(1200), opts))
			dns, end, err := collect(t, s, "ou=people,"+testBase, ScopeSubtree, 500)
			if err != nil {
				t.Fatalf("a size limit is not a failure: %v", err)
			}
			if end.Cut != CutByServer || len(dns) != opts.SizeLimit {
				t.Fatalf("got %d entries, cut %v; want %d and CutByServer", len(dns), end.Cut, opts.SizeLimit)
			}
		})
	}
}

func TestStreamReportsAMissingBase(t *testing.T) {
	s, _ := connect(t, fakeldap.Start(t, directory(1), fakeldap.Options{Paging: true}))
	_, _, err := collect(t, s, "ou=nobody,"+testBase, ScopeSubtree, 500)
	var le *Error
	if !errors.As(err, &le) || le.Code != 32 {
		t.Fatalf("got %v, want a No such object (32) error", err)
	}
}

func TestStreamStopsWhenTheConsumerFails(t *testing.T) {
	srv := fakeldap.Start(t, directory(1200), fakeldap.Options{Paging: true})
	s, _ := connect(t, srv)
	boom := errors.New("disk full")
	n := 0
	_, err := s.Stream(context.Background(), testBase, ScopeSubtree, 500, func(*ldap.Entry) error {
		if n++; n == 10 {
			return boom
		}
		return nil
	})
	if !errors.Is(err, boom) || n != 10 {
		t.Fatalf("got %v after %d entries, want the consumer's own error after 10", err, n)
	}
	// The connection is ready for the next search.
	if dns, _, err := collect(t, s, "ou=groups,"+testBase, ScopeBase, 500); err != nil || len(dns) != 1 {
		t.Fatalf("the next read: %v, %v", dns, err)
	}
}

func TestStreamCanBeCanceled(t *testing.T) {
	srv := fakeldap.Start(t, directory(1200), fakeldap.Options{Paging: true, Delay: 200 * time.Millisecond})
	s, _ := connect(t, srv)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	_, err := s.Stream(ctx, testBase, ScopeSubtree, 500, func(*ldap.Entry) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want the cancellation", err)
	}
}

func TestDNKeyIgnoresCaseAndSpaces(t *testing.T) {
	if DNKey("UID=Ada, ou=People ,dc=example,dc=org") != DNKey("uid=ada,ou=people,dc=example,dc=org") {
		t.Fatal("two spellings of one DN got different keys")
	}
	if DNKey("uid=ada,dc=org") == DNKey("uid=grace,dc=org") {
		t.Fatal("two DNs got the same key")
	}
	if ParentDN("uid=ada,ou=people,dc=org") != "ou=people,dc=org" {
		t.Fatal("ParentDN")
	}
}
