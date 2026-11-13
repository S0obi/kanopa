//go:build integration

package services

import (
	"context"
	"reflect"
	"testing"

	"github.com/S0obi/kanopa/internal/testldap"
)

// A posixGroup lists its members by uid. Adding and removing a memberUid goes through the same
// apply as any other change, and a posixGroup may be created with no member at all.
func TestApplyPosixMembership(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c := NewChangeService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)
	groups := "ou=groups," + testldap.BaseDN
	valuesOf := func(dn, attr string) []string {
		for _, a := range d.Entry(ctx, admin, dn).Attributes {
			if a.Name == attr {
				return a.Values
			}
		}
		return nil
	}

	t.Run("add and remove a uid", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{
			{Op: opModify, DN: "cn=unix-empty," + groups, Attributes: []AttributeChange{{Name: "memberUid", Kind: "text", Add: []string{"ada", "grace"}}}},
			{Op: opModify, DN: "cn=unix-staff," + groups, Attributes: []AttributeChange{{Name: "memberUid", Kind: "text", Remove: []string{"grace"}}}},
		})
		if r.Failure != nil || r.Applied != 2 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if got := valuesOf("cn=unix-empty,"+groups, "memberUid"); !reflect.DeepEqual(got, []string{"ada", "grace"}) {
			t.Fatalf("unix-empty now lists %v", got)
		}
		if got := valuesOf("cn=unix-staff,"+groups, "memberUid"); !reflect.DeepEqual(got, []string{"ada", "alan"}) {
			t.Fatalf("unix-staff now lists %v", got)
		}
	})

	t.Run("create a posixGroup with no member, and one with members", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{
			{Op: opAdd, DN: "cn=unix-new," + groups, Attributes: []AttributeChange{
				{Name: "objectClass", Kind: "text", After: []string{"posixGroup", "top"}},
				{Name: "cn", Kind: "text", After: []string{"unix-new"}},
				{Name: "gidNumber", Kind: "text", After: []string{"2100"}},
			}},
			{Op: opAdd, DN: "cn=unix-team," + groups, Attributes: []AttributeChange{
				{Name: "objectClass", Kind: "text", After: []string{"posixGroup", "top"}},
				{Name: "cn", Kind: "text", After: []string{"unix-team"}},
				{Name: "gidNumber", Kind: "text", After: []string{"2101"}},
				{Name: "memberUid", Kind: "text", After: []string{"alan", "ada"}},
			}},
		})
		if r.Failure != nil || r.Applied != 2 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if got := valuesOf("cn=unix-team,"+groups, "memberUid"); len(got) != 2 {
			t.Fatalf("unix-team lists %v", got)
		}
		if got := valuesOf("cn=unix-new,"+groups, "memberUid"); len(got) != 0 {
			t.Fatalf("unix-new should list no member: %v", got)
		}
		// The next free gidNumber moves past the new ones.
		if gid := d.GIDCheck(ctx, admin, 2100); gid.Next < 2102 || len(gid.TakenBy) != 1 || gid.TakenBy[0] != "unix-new" {
			t.Fatalf("gid check %+v", gid)
		}
	})

	t.Run("a gidNumber is required", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{{Op: opAdd, DN: "cn=no-gid," + groups, Attributes: []AttributeChange{
			{Name: "objectClass", Kind: "text", After: []string{"posixGroup", "top"}},
			{Name: "cn", Kind: "text", After: []string{"no-gid"}},
		}}})
		if f := r.Results[0].Failure; f == nil || f.Code != 65 {
			t.Fatalf("want an object class violation (65): %+v", f)
		}
	})
}

// Any entry can hold children, not only an OU: some directories keep their groups below an
// organizationalRole (cn=Group factory in ou=edge, which already holds cn=made-here).
func TestCreateGroupsBelowARole(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c := NewChangeService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)
	role := "cn=Group factory,ou=edge," + testldap.BaseDN

	before := d.Children(ctx, admin, role, "")
	if before.Failure != nil || before.Total != 1 || before.Nodes[0].Type != "group" {
		t.Fatalf("the role holds one group: %+v", before)
	}
	r := c.Apply(ctx, admin, []EntryChange{{Op: opAdd, DN: "cn=second," + role, Attributes: []AttributeChange{
		{Name: "objectClass", Kind: "text", After: []string{"groupOfNames", "top"}},
		{Name: "cn", Kind: "text", After: []string{"second"}},
		{Name: "member", Kind: "dn", After: []string{"uid=ada,ou=people," + testldap.BaseDN}},
	}}})
	if r.Failure != nil || r.Applied != 1 {
		t.Fatalf("apply %+v %+v", r.Failure, r.Results)
	}
	after := d.Children(ctx, admin, role, "")
	if after.Failure != nil || after.Total != 2 {
		t.Fatalf("the role now holds two groups: %+v", after)
	}
}
