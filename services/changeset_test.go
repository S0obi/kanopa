package services

import (
	"strings"
	"testing"
)

const (
	people = "ou=people,dc=example,dc=org"
	groups = "ou=groups,dc=example,dc=org"
)

// summary is "op dn" per step, in order.
func summary(steps []step) string {
	var lines []string
	for _, s := range steps {
		line := s.op + " " + s.dn
		if s.op == opRename {
			line += " -> " + s.newDN
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func TestOrderMixedChangeSet(t *testing.T) {
	changes := []EntryChange{
		{Op: opDelete, DN: "ou=old,ou=teams,dc=example,dc=org"},
		{Op: opDelete, DN: "cn=x,ou=old,ou=teams,dc=example,dc=org"},
		{DN: "uid=ada," + people, Attributes: []AttributeChange{{Name: "title", Kind: "text", Before: []string{"a"}, After: []string{"b"}}}},
		{Op: opAdd, DN: "cn=lab,ou=teams,dc=example,dc=org"},
		{Op: opAdd, DN: "ou=teams,dc=example,dc=org"},
		{Op: opRename, DN: "uid=ada," + people, NewRDN: "ada.l"},
		{DN: "cn=admins," + groups, Attributes: []AttributeChange{{Name: "member", Kind: "dn", Remove: []string{"uid=ada," + people}, Add: []string{"uid=ada," + people}}}},
	}
	steps, err := orderChanges(changes)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"rename uid=ada," + people + " -> uid=ada.l," + people,
		"add ou=teams,dc=example,dc=org",
		"add cn=lab,ou=teams,dc=example,dc=org",
		"modify uid=ada.l," + people,
		"modify cn=admins," + groups,
		"delete cn=x,ou=old,ou=teams,dc=example,dc=org",
		"delete ou=old,ou=teams,dc=example,dc=org",
	}, "\n")
	if got := summary(steps); got != want {
		t.Fatalf("order:\n%s\nwant:\n%s", got, want)
	}
	// Each step remembers which change it was.
	if steps[0].index != 5 || steps[3].index != 2 || steps[6].index != 0 {
		t.Fatalf("indexes %d %d %d", steps[0].index, steps[3].index, steps[6].index)
	}
	// DN values follow the rename; what is removed stays as the server holds it.
	m := steps[4].ch.Attributes[0]
	if m.Add[0] != "uid=ada.l,"+people || m.Remove[0] != "uid=ada,"+people {
		t.Fatalf("member delta %+v", m)
	}
}

func TestRenameRewritesReferencesAndEscapes(t *testing.T) {
	steps, err := orderChanges([]EntryChange{
		{Op: opRename, DN: "cn=Doe\\, Jane," + people, NewRDN: "Doe, John"},
		{DN: "uid=grace," + people, Attributes: []AttributeChange{{Name: "manager", Kind: "dn", Before: []string{"uid=x"}, After: []string{"CN=doe\\, jane, OU=People,dc=example,dc=org"}}}},
		{Op: opAdd, DN: "cn=child,cn=Doe\\, Jane," + people},
	})
	if err != nil {
		t.Fatal(err)
	}
	if steps[0].newRDN != `cn=Doe\, John` || steps[0].newDN != `cn=Doe\, John,`+people {
		t.Fatalf("rename %+v", steps[0])
	}
	if got := steps[1].dn; got != `cn=child,cn=Doe\, John,`+people {
		t.Fatalf("an add below a renamed entry moves with it: %s", got)
	}
	if got := steps[2].ch.Attributes[0].After[0]; got != `cn=Doe\, John,`+people {
		t.Fatalf("a DN value follows the rename however it is spelled: %s", got)
	}
}

func TestOrderRefusesContradictions(t *testing.T) {
	for _, set := range [][]EntryChange{
		{{Op: opDelete, DN: "uid=ada," + people}, {Op: opRename, DN: "uid=ada," + people, NewRDN: "x"}},
		{{Op: opRename, DN: "dc=org", NewRDN: "x"}},
		{{Op: opRename, DN: "uid=ada," + people, NewRDN: "  "}},
		{{Op: "move", DN: "uid=ada," + people}},
		{{Op: opRename, DN: "cn=a+uid=b," + people, NewRDN: "x"}},
	} {
		if _, err := orderChanges(set); err == nil {
			t.Errorf("want an error for %+v", set)
		}
	}
}

func TestRDNsAndParents(t *testing.T) {
	if got := rdns(`cn=a\,b, ou=x,dc=org`); strings.Join(got, "|") != `cn=a\,b|ou=x|dc=org` {
		t.Fatalf("rdns %q", got)
	}
	if parentOf(`cn=a\,b,ou=x,dc=org`) != "ou=x,dc=org" || parentOf("dc=org") != "" {
		t.Fatal("parentOf")
	}
	if withParent("cn=c,uid=a,ou=p,dc=org", "uid=a,ou=p,dc=org", "uid=b,ou=p,dc=org") != "cn=c,uid=b,ou=p,dc=org" {
		t.Fatal("withParent")
	}
}
