//go:build integration

package services

import (
	"context"
	"reflect"
	"strconv"
	"strings"
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

// A person can also be a posixAccount: the dialog suggests the next free uidNumber, offers the
// posixGroups as primary group, and the entry holds both classes.
func TestCreatePosixUser(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c := NewChangeService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)

	info := d.POSIXInfo(ctx, admin, 3001)
	if info.Failure != nil {
		t.Fatalf("posix info: %+v", info.Failure)
	}
	if info.NextUID < 3002 || len(info.UIDTakenBy) != 1 || info.UIDTakenBy[0] != "casey" {
		t.Fatalf("uid 3001 belongs to casey, and the next free one is above it: %+v", info)
	}
	var staff *PosixGroup
	for i := range info.Groups {
		if info.Groups[i].CN == "unix-staff" {
			staff = &info.Groups[i]
		}
	}
	if staff == nil || staff.GID == 0 {
		t.Fatalf("unix-staff should be offered as a primary group: %+v", info.Groups)
	}
	if free := d.POSIXInfo(ctx, admin, 9_999_999); len(free.UIDTakenBy) != 0 {
		t.Fatalf("nobody holds 9999999: %+v", free.UIDTakenBy)
	}

	dn := "uid=alovelace,ou=people," + testldap.BaseDN
	text := func(name string, v ...string) AttributeChange {
		return AttributeChange{Name: name, Kind: "text", After: v}
	}
	r := c.Apply(ctx, admin, []EntryChange{{Op: opAdd, DN: dn, Attributes: []AttributeChange{
		text("objectClass", "inetOrgPerson", "organizationalPerson", "person", "posixAccount", "top"),
		text("uid", "alovelace"), text("cn", "Ada Lovelace"), text("sn", "Lovelace"), text("givenName", "Ada"),
		text("uidNumber", strconv.Itoa(info.NextUID)), text("gidNumber", strconv.Itoa(staff.GID)),
		text("homeDirectory", "/home/alovelace"), text("loginShell", "/bin/bash"),
	}}})
	if r.Failure != nil || r.Applied != 1 {
		t.Fatalf("apply %+v %+v", r.Failure, r.Results)
	}
	got := d.Entry(ctx, admin, dn)
	if got.Failure != nil {
		t.Fatalf("read back: %+v", got.Failure)
	}
	classes := strings.Join(got.ObjectClasses, ",")
	if !strings.Contains(classes, "posixAccount") || !strings.Contains(classes, "inetOrgPerson") {
		t.Fatalf("the entry should be both: %s", classes)
	}
	// The number is now in use, and the next suggestion moves past it.
	after := d.POSIXInfo(ctx, admin, info.NextUID)
	if len(after.UIDTakenBy) != 1 || after.UIDTakenBy[0] != "alovelace" || after.NextUID <= info.NextUID {
		t.Fatalf("after the create: %+v", after)
	}
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
