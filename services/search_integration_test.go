//go:build integration

package services

import (
	"context"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/testldap"
)

func TestQuickFindAgainstTheFixture(t *testing.T) {
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	id := connectFixture(t, s, "show")
	ctx := context.Background()

	// A word finds Ada, best match first, whatever the object class.
	r := d.Quick(ctx, id, "ada")
	if r.Failure != nil || r.Invalid != nil || len(r.Hits) == 0 {
		t.Fatalf("got %+v", r)
	}
	if r.Hits[0].DN != "uid=ada,ou=people,"+testldap.BaseDN || r.Hits[0].Name != "Ada Lovelace" || r.Hits[0].Type != "person" || !strings.Contains(r.Hits[0].Sub, "@") {
		t.Fatalf("first hit %+v", r.Hits[0])
	}
	if r.Mode != ModeNames || !r.Paged {
		t.Fatalf("mode %s paged %v", r.Mode, r.Paged)
	}

	// Several words, and a group by its name.
	if r := d.Quick(ctx, id, "ada lov"); len(r.Hits) != 1 || r.Hits[0].Name != "Ada Lovelace" {
		t.Fatalf("ada lov: %+v", r.Hits)
	}
	if r := d.Quick(ctx, id, "engineering"); len(r.Hits) == 0 || r.Hits[0].Type != "group" {
		t.Fatalf("engineering: %+v", r.Hits)
	}

	// A DN pasted from Copy DN finds that entry, and a DN nobody has finds nothing.
	if r := d.Quick(ctx, id, "uid=ada,ou=people,"+testldap.BaseDN); r.Mode != ModeDN || len(r.Hits) != 1 || r.Hits[0].Name != "Ada Lovelace" {
		t.Fatalf("by DN: %+v", r)
	}
	if r := d.Quick(ctx, id, "uid=nobody,ou=people,"+testldap.BaseDN); r.Failure != nil || len(r.Hits) != 0 {
		t.Fatalf("no such DN: %+v", r)
	}

	// 1,182 people: 200 are read, ranked, and 10 shown.
	many := d.Quick(ctx, id, "ou=people")
	if many.Mode != ModeFilter {
		t.Fatalf("ou=people is an LDAP query, got %s", many.Mode)
	}
	all := d.Quick(ctx, id, "(objectClass=inetOrgPerson)")
	if all.Failure != nil || all.Total != 200 || !all.More || len(all.Hits) != 10 {
		t.Fatalf("total %d more %v hits %d failure %+v", all.Total, all.More, len(all.Hits), all.Failure)
	}

	// An invalid filter never reaches the server.
	if bad := d.Quick(ctx, id, "(&(uid=ada)"); bad.Invalid == nil || bad.Invalid.Position != 11 {
		t.Fatalf("got %+v", bad)
	}
}
