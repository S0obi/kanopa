//go:build integration

package services

import (
	"context"
	"testing"
	"time"

	"github.com/S0obi/kanopa/internal/testldap"
)

// The large profile (KANOPA_LDAP_PROFILE=large, after `task ldap:seed-large`): ou=archive with 10,000
// people, and cn=everyone with 5,000 members. A laptop measures these in tens to hundreds of
// milliseconds (see the -v output); the limits are many times that, so a real regression fails them
// and a slow CI runner does not.
const (
	archiveOU    = "ou=archive," + testldap.BaseDN
	everyoneDN   = "cn=everyone,ou=groups," + testldap.BaseDN
	listBudget   = 2 * time.Second
	entryBudget  = 1 * time.Second
	searchBudget = 1 * time.Second
)

func needLarge(t *testing.T) {
	t.Helper()
	if !testldap.Large() {
		t.Skip("the large profile is opt-in: task ldap:seed-large, then KANOPA_LDAP_PROFILE=large")
	}
}

func within(t *testing.T, what string, budget time.Duration, f func()) {
	t.Helper()
	start := time.Now()
	f()
	took := time.Since(start)
	t.Logf("%s: %s (limit %s)", what, took.Round(time.Millisecond), budget)
	if took > budget {
		t.Fatalf("%s took %s, over %s", what, took, budget)
	}
}

func TestLargeOUOpens(t *testing.T) {
	needLarge(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	id := connectFixture(t, s, "show")
	ctx := context.Background()

	var first TreeResult
	within(t, "read the 10,000 children of ou=archive", listBudget, func() { first = d.Children(ctx, id, archiveOU, "") })
	if first.Failure != nil || first.Total != 10_000 || first.Truncated || len(first.Nodes) != 500 || first.More == "" {
		t.Fatalf("total %d nodes %d more %q truncated %v failure %+v", first.Total, len(first.Nodes), first.More, first.Truncated, first.Failure)
	}
	// The next pages come from what was read, with no second trip to the server.
	within(t, "page through all 20 pages", 500*time.Millisecond, func() {
		seen := len(first.Nodes)
		for more := first.More; more != ""; {
			p := d.Children(ctx, id, archiveOU, more)
			seen += len(p.Nodes)
			more = p.More
		}
		if seen != 10_000 {
			t.Fatalf("paged %d of 10,000", seen)
		}
	})
	within(t, "count the children without reading them", entryBudget, func() {
		if c := d.CountChildren(ctx, id, archiveOU); c.Failure != nil || c.Count != 10_000 || c.More {
			t.Fatalf("count %+v", c)
		}
	})
}

func TestLargeGroupOpens(t *testing.T) {
	needLarge(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	id := connectFixture(t, s, "show")
	ctx := context.Background()

	var e EntryView
	within(t, "read cn=everyone with its 5,000 members", entryBudget, func() { e = d.Entry(ctx, id, everyoneDN) })
	if e.Failure != nil {
		t.Fatalf("failure %+v", e.Failure)
	}
	members := 0
	for _, a := range e.Attributes {
		if a.Name == "member" {
			members = len(a.Values)
		}
	}
	if members != 5_000 {
		t.Fatalf("%d members listed", members)
	}

	within(t, "find the groups of one member", searchBudget, func() {
		r := d.MemberOf(ctx, id, "uid=arch00042,"+archiveOU)
		if r.Failure != nil || len(r.Entries) != 1 || r.Entries[0].Name != "everyone" {
			t.Fatalf("got %+v", r)
		}
	})
}

func TestLargeSearches(t *testing.T) {
	needLarge(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	id := connectFixture(t, s, "show")
	ctx := context.Background()

	within(t, "header search over 11,000 people for a word", searchBudget, func() {
		r := d.Quick(ctx, id, "archive")
		if r.Failure != nil || r.Total != 200 || !r.More || len(r.Hits) != 10 {
			t.Fatalf("total %d more %v hits %d failure %+v", r.Total, r.More, len(r.Hits), r.Failure)
		}
	})
	within(t, "header search for one entry", searchBudget, func() {
		if r := d.Quick(ctx, id, "arch09999"); r.Failure != nil || len(r.Hits) != 1 || r.Hits[0].Name != "Archive 9999" {
			t.Fatalf("got %+v", r)
		}
	})
	within(t, "header search by an LDAP filter", searchBudget, func() {
		if r := d.Quick(ctx, id, "(&(objectClass=inetOrgPerson)(mail=arch0999*))"); r.Failure != nil || r.Total != 10 {
			t.Fatalf("got %+v", r)
		}
	})
}
