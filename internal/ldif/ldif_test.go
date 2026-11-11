package ldif

import (
	"strings"
	"testing"
)

func TestEntry(t *testing.T) {
	got := Entry("uid=ada,ou=people,dc=example,dc=org", []Attribute{
		{Name: "objectClass", Values: [][]byte{[]byte("inetOrgPerson"), []byte("top")}},
		{Name: "cn", Values: [][]byte{[]byte("Ada Lovelace")}},
		{Name: "sn", Values: [][]byte{[]byte("Lüthi")}},
		{Name: "description", Values: [][]byte{[]byte(" leading space"), []byte(":colon"), []byte("<angle"), []byte("trailing ")}},
		{Name: "jpegPhoto", Values: [][]byte{{0xff, 0xd8, 0xff, 0x00}}},
		{Name: "empty", Values: [][]byte{{}}},
	})
	want := `dn: uid=ada,ou=people,dc=example,dc=org
objectClass: inetOrgPerson
objectClass: top
cn: Ada Lovelace
sn:: TMO8dGhp
description:: IGxlYWRpbmcgc3BhY2U=
description:: OmNvbG9u
description:: PGFuZ2xl
description:: dHJhaWxpbmcg
jpegPhoto:: /9j/AA==
empty:
`
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestFolding(t *testing.T) {
	long := strings.Repeat("abcdefghij", 20) // 200 bytes
	out := Entry("cn=x", []Attribute{{Name: "description", Values: [][]byte{[]byte(long)}}})
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("want dn + 3 folded lines, got %d:\n%s", len(lines), out)
	}
	rebuilt := ""
	for i, l := range lines[1:] {
		if len(l) > Width {
			t.Fatalf("line %d is %d long", i, len(l))
		}
		if i > 0 {
			if l[0] != ' ' {
				t.Fatalf("continuation without a leading space: %q", l)
			}
			l = l[1:]
		}
		rebuilt += l
	}
	if rebuilt != "description: "+long {
		t.Fatal("folding lost or changed bytes")
	}
}

func TestFoldingKeepsUTF8Whole(t *testing.T) {
	var b strings.Builder
	fold(&b, "dn: "+strings.Repeat("é", 60))
	for _, l := range strings.Split(strings.TrimSuffix(b.String(), "\n"), "\n") {
		if !strings.HasPrefix(l, "dn") && !strings.HasPrefix(l, " é") && !strings.HasPrefix(l, " ") {
			t.Fatalf("bad line %q", l)
		}
		if strings.ContainsRune(l, '\uFFFD') {
			t.Fatal("a UTF-8 sequence was split")
		}
	}
}

func TestModify(t *testing.T) {
	got := Modify("uid=ada,ou=people,dc=example,dc=org", []string{"Ada Lovelace"}, []Change{
		{Op: "replace", Name: "title", Values: [][]byte{[]byte("Analyst")}},
		{Op: "add", Name: "description", Values: [][]byte{[]byte(" leading space")}},
		{Op: "delete", Name: "jpegPhoto", Notes: []string{"1 binary value, not shown"}},
	})
	want := "# Ada Lovelace\n" +
		"dn: uid=ada,ou=people,dc=example,dc=org\n" +
		"changetype: modify\n" +
		"replace: title\ntitle: Analyst\n-\n" +
		"add: description\ndescription:: IGxlYWRpbmcgc3BhY2U=\n-\n" +
		"delete: jpegPhoto\n# 1 binary value, not shown\n-\n"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestAddDeleteModRDN(t *testing.T) {
	add := Add("uid=zoe,ou=people,dc=example,dc=org", []string{"New entry"}, []Attribute{
		{Name: "objectClass", Values: [][]byte{[]byte("inetOrgPerson")}},
		{Name: "l", Values: [][]byte{[]byte("Zürich")}},
	}, []string{"userPassword is set after the add; it is not shown."})
	want := "# New entry\ndn: uid=zoe,ou=people,dc=example,dc=org\nchangetype: add\nobjectClass: inetOrgPerson\nl:: WsO8cmljaA==\n# userPassword is set after the add; it is not shown.\n"
	if add != want {
		t.Fatalf("add:\n%s", add)
	}
	if got := Delete("uid=zoe,dc=org", nil); got != "dn: uid=zoe,dc=org\nchangetype: delete\n" {
		t.Fatalf("delete:\n%s", got)
	}
	if got := ModRDN("uid=zoe,dc=org", nil, "uid=zoe.z"); got != "dn: uid=zoe,dc=org\nchangetype: modrdn\nnewrdn: uid=zoe.z\ndeleteoldrdn: 1\n" {
		t.Fatalf("modrdn:\n%s", got)
	}
}
