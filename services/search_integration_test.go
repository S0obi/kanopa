//go:build integration

package services

import (
	"context"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/testldap"
)

func TestSearchAgainstTheFixture(t *testing.T) {
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	id := connectFixture(t, s, "show")
	ctx := context.Background()

	// The fixture has 1,182 people: a subtree search stops at Kanopa's 500 and says so.
	all := d.Search(ctx, id, SearchRequest{Scope: "sub", Filter: "(objectClass=inetOrgPerson)"})
	if all.Failure != nil {
		t.Fatalf("failure %+v", all.Failure)
	}
	if len(all.Rows) != 500 || !all.Truncated || all.ServerLimit || !all.Paged {
		t.Fatalf("rows %d truncated %v serverLimit %v paged %v", len(all.Rows), all.Truncated, all.ServerLimit, all.Paged)
	}
	seen := map[string]bool{}
	for _, r := range all.Rows {
		if seen[strings.ToLower(r.DN)] {
			t.Fatalf("%s listed twice: paging past 100 repeated an entry", r.DN)
		}
		seen[strings.ToLower(r.DN)] = true
		if r.Type != "person" {
			t.Fatalf("%s is a %s", r.DN, r.Type)
		}
	}

	// A narrower search reads everything it matches.
	ada := d.Search(ctx, id, SearchRequest{Base: "ou=people," + testldap.BaseDN, Scope: "one", Filter: "(uid=ada)", Attributes: []string{"mail", "title"}})
	if ada.Failure != nil || len(ada.Rows) != 1 || ada.Truncated {
		t.Fatalf("ada: %+v", ada)
	}
	row := ada.Rows[0]
	if row.Name != "Ada Lovelace" || len(row.Cells) != 2 || len(row.Cells[0]) != 1 || !strings.Contains(row.Cells[0][0], "@") {
		t.Fatalf("row %+v", row)
	}

	// Each scope.
	for _, tc := range []struct {
		scope string
		base  string
		want  int
	}{
		{"base", "ou=groups," + testldap.BaseDN, 1},
		{"one", "ou=groups," + testldap.BaseDN, 24},
		{"sub", "ou=groups," + testldap.BaseDN, 25},
	} {
		r := d.Search(ctx, id, SearchRequest{Base: tc.base, Scope: tc.scope, Filter: "(objectClass=*)"})
		if r.Failure != nil || len(r.Rows) != tc.want {
			t.Fatalf("%s under %s: %d rows, want %d (%+v)", tc.scope, tc.base, len(r.Rows), tc.want, r.Failure)
		}
	}

	// A filter that is wrong never reaches the server; a base that is not there is the server's answer.
	if bad := d.Search(ctx, id, SearchRequest{Scope: "sub", Filter: "(&(uid=ada)"}); bad.Failure == nil || bad.Failure.Title != "The filter is not valid." {
		t.Fatalf("got %+v", bad.Failure)
	}
	if missing := d.Search(ctx, id, SearchRequest{Base: "ou=nowhere," + testldap.BaseDN, Scope: "sub", Filter: "(uid=ada)"}); missing.Failure == nil || missing.Failure.Code != 32 {
		t.Fatalf("got %+v", missing.Failure)
	}

	// The fixture's schema offers attribute names for completing.
	names := d.AttributeNames(id)
	if len(names) < 50 {
		t.Fatalf("%d attribute names", len(names))
	}
	has := map[string]bool{}
	for _, n := range names {
		has[strings.ToLower(n)] = true
	}
	if !has["uid"] || !has["mail"] || !has["member"] {
		t.Fatal("uid, mail and member should be offered")
	}
}
