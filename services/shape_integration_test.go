//go:build integration

package services

import (
	"context"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/testldap"
)

func TestShapeTheTree(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c := NewChangeService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)
	people := "ou=people," + testldap.BaseDN
	zoe := "uid=zoe," + people
	team := "cn=kanopa-team,ou=groups," + testldap.BaseDN

	t.Run("add a person and a group with her as member", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{
			// The group comes first: without the refint overlay a member need not exist yet.
			{Op: opAdd, DN: team, Attributes: []AttributeChange{
				{Name: "objectClass", Kind: "text", After: []string{"groupOfNames", "top"}},
				{Name: "cn", Kind: "text", After: []string{"kanopa-team"}},
				{Name: "member", Kind: "dn", After: []string{zoe}},
			}},
			{Op: opAdd, DN: zoe, Attributes: []AttributeChange{
				{Name: "objectClass", Kind: "text", After: []string{"inetOrgPerson", "organizationalPerson", "person", "top"}},
				{Name: "uid", Kind: "text", After: []string{"zoe"}},
				{Name: "cn", Kind: "text", After: []string{"Zoë Zürcher"}},
				{Name: "sn", Kind: "text", After: []string{"Zürcher"}},
				{Name: "userPassword", Kind: "password", Password: "zoe-Passw0rd"},
			}},
		})
		if r.Failure != nil || r.Applied != 2 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if r.Results[0].Index != 0 || r.Results[1].Index != 1 || r.Results[1].Node == nil || r.Results[1].Node.Type != "person" {
			t.Fatalf("results %+v", r.Results)
		}
		ok := s.Test(ctx, ConnectionParams{URL: srv.LDAPSURL(), Security: "ldaps", Bind: "simple", BindDN: zoe, Password: "zoe-Passw0rd", TimeoutSeconds: 5})
		if !ok.OK {
			t.Fatalf("bind as the new person: %+v", ok)
		}
		// The tree lists her: the parent's cached list was dropped.
		kids := d.Children(ctx, admin, people, "")
		if kids.Total != 1183 {
			t.Fatalf("people now %d", kids.Total)
		}
	})

	t.Run("groupOfNames with no member is refused", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{{Op: opAdd, DN: "cn=empty,ou=groups," + testldap.BaseDN, Attributes: []AttributeChange{
			{Name: "objectClass", Kind: "text", After: []string{"groupOfNames", "top"}},
			{Name: "cn", Kind: "text", After: []string{"empty"}},
		}}})
		f := r.Results[0].Failure
		if f == nil || f.Code != 65 || !strings.HasPrefix(f.Message, "Object class violation (65) — groupOfNames requires the attribute member.") {
			t.Fatalf("want 65: %+v", f)
		}
	})

	t.Run("people search and referrers", func(t *testing.T) {
		found := d.Find(ctx, admin, "people", "Zoë")
		if found.Failure != nil || !strings.Contains(found.Filter, "(cn=*Zoë*)") || found.Base != testldap.BaseDN {
			t.Fatalf("find %+v", found)
		}
		var names []string
		for _, e := range found.Entries {
			names = append(names, e.Name)
		}
		if strings.Join(names, ",") != "Zoë Zürcher" || found.Total != 1 {
			t.Fatalf("hits %v", names)
		}
		many := d.Find(ctx, admin, "people", "an")
		if len(many.Entries) != 8 || many.Total <= 8 {
			t.Fatalf("first 8 of %d: %d", many.Total, len(many.Entries))
		}
		g := d.Find(ctx, admin, "groups", "kanopa")
		if len(g.Entries) != 1 || g.Entries[0].MemberAttr != "member" {
			t.Fatalf("groups %+v", g)
		}
		refs := d.Referrers(ctx, admin, zoe)
		if len(refs.Entries) != 1 || refs.Entries[0].DN != team || refs.Entries[0].MemberAttr != "member" {
			t.Fatalf("referrers %+v", refs)
		}
	})

	t.Run("object classes for the New entry form", func(t *testing.T) {
		r := d.ObjectClasses(admin)
		var device *ClassInfo
		for i := range r.Classes {
			if r.Classes[i].Name == "device" {
				device = &r.Classes[i]
			}
			if r.Classes[i].Kind == "ABSTRACT" {
				t.Fatalf("abstract class offered: %s", r.Classes[i].Name)
			}
		}
		if r.Failure != nil || device == nil || device.Kind != "STRUCTURAL" || len(device.Must) != 1 || device.Must[0].Name != "cn" {
			t.Fatalf("device %+v (%d classes)", device, len(r.Classes))
		}
		r2 := c.Apply(ctx, admin, []EntryChange{{Op: opAdd, DN: "cn=printer01,ou=hosts," + testldap.BaseDN, Attributes: []AttributeChange{
			{Name: "objectClass", Kind: "text", After: []string{"device", "top"}},
			{Name: "cn", Kind: "text", After: []string{"printer01"}},
			{Name: "description", Kind: "text", After: []string{"Second floor"}},
		}}})
		if r2.Applied != 1 || r2.Results[0].Node == nil || r2.Results[0].Node.Type != "server" {
			t.Fatalf("add a device: %+v", r2.Results)
		}
	})

	newZoe := "uid=zoe.z," + people
	t.Run("rename keeps the group in step", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{
			{DN: team, Attributes: []AttributeChange{{Name: "member", Kind: "dn", Remove: []string{zoe}, Add: []string{zoe}}}},
			{Op: opRename, DN: zoe, NewRDN: "zoe.z"},
		})
		if r.Failure != nil || r.Applied != 2 || r.Results[0].Op != opRename || r.Results[0].DN != newZoe {
			t.Fatalf("rename %+v %+v", r.Failure, r.Results)
		}
		g := d.Entry(ctx, admin, team)
		if m := attrOf(g, "member").Values; len(m) != 1 || !strings.EqualFold(m[0], newZoe) {
			t.Fatalf("member after rename %v", m)
		}
		if e := d.Entry(ctx, admin, newZoe); e.Failure != nil || attrOf(e, "uid").Values[0] != "zoe.z" || len(attrOf(e, "uid").Values) != 1 {
			t.Fatalf("renamed entry %+v", e.Failure)
		}
	})

	t.Run("rename and delete refuse entries with children", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{{Op: opRename, DN: "ou=hosts," + testldap.BaseDN, NewRDN: "machines"}})
		if f := r.Results[0].Failure; f == nil || f.Code != 66 {
			t.Fatalf("rename non-leaf: %+v", f)
		}
		r = c.Apply(ctx, admin, []EntryChange{{Op: opDelete, DN: "ou=hosts," + testldap.BaseDN}})
		if f := r.Results[0].Failure; f == nil || f.Code != 66 || !strings.HasPrefix(f.Message, "Not allowed on non-leaf (66) — ") {
			t.Fatalf("delete non-leaf: %+v", f)
		}
		r = c.Apply(ctx, admin, []EntryChange{{Op: opDelete, DN: testldap.BaseDN}})
		if r.Failure == nil {
			t.Fatal("the base DN is never deleted")
		}
	})

	t.Run("delete a leaf with membership cleanup", func(t *testing.T) {
		// kanopa-team would lose its only member: give it another one in the same set.
		r := c.Apply(ctx, admin, []EntryChange{
			{Op: opDelete, DN: newZoe},
			{DN: team, Attributes: []AttributeChange{{Name: "member", Kind: "dn", Remove: []string{newZoe}, Add: []string{"uid=ada," + people}}}},
		})
		if r.Failure != nil || r.Applied != 2 || r.Results[0].Op != opModify || r.Results[1].Op != opDelete {
			t.Fatalf("delete %+v %+v", r.Failure, r.Results)
		}
		if f := d.Entry(ctx, admin, newZoe).Failure; f == nil || f.Code != 32 {
			t.Fatalf("zoe should be gone: %+v", f)
		}
		if m := attrOf(d.Entry(ctx, admin, team), "member").Values; len(m) != 1 || !strings.HasPrefix(m[0], "uid=ada,") {
			t.Fatalf("member after cleanup %v", m)
		}
	})

	t.Run("a value to remove that is gone is a conflict", func(t *testing.T) {
		r := c.Apply(ctx, admin, []EntryChange{{DN: team, Attributes: []AttributeChange{
			{Name: "member", Kind: "dn", Remove: []string{"uid=nobody," + people}, Add: []string{"uid=grace," + people}}}}})
		if f := r.Results[0].Failure; f == nil || f.Code != 122 || !strings.Contains(f.Message, "member changed") {
			t.Fatalf("want 122 on member: %+v", f)
		}
	})
}
