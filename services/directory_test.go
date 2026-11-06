package services

import (
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/ldapx"
)

func TestFirstRDN(t *testing.T) {
	for in, want := range map[string]string{
		"uid=ada,ou=people,dc=example,dc=org": "uid=ada",
		`cn=Lovelace\, Ada,ou=people`:         `cn=Lovelace\, Ada`,
		"dc=org":                              "dc=org",
	} {
		if got := firstRDN(in); got != want {
			t.Errorf("firstRDN(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTypeOf(t *testing.T) {
	cases := map[string][]string{
		"root":   {"dcObject", "organization", "top"},
		"ou":     {"organizationalUnit", "top"},
		"person": {"inetOrgPerson", "organizationalPerson", "person", "top"},
		"group":  {"groupOfNames", "top"},
		"server": {"device", "ipHost", "top"},
		"entry":  {"account", "simpleSecurityObject", "top"},
	}
	for want, classes := range cases {
		if got := typeOf(classes, false); got != want {
			t.Errorf("typeOf(%v) = %s, want %s", classes, got, want)
		}
	}
}

func TestNodeOf(t *testing.T) {
	yes, no := true, false
	n := nodeOf(ldapx.Child{DN: "ou=people,dc=example,dc=org", ObjectClasses: []string{"organizationalUnit"}, Description: "People", HasSubordinates: &yes, NumSubordinates: -1})
	if n.RDN != "ou=people" || n.Type != "ou" || n.Sub != "People" || !n.HasChildren || n.Count != -1 {
		t.Fatalf("unexpected %+v", n)
	}
	p := nodeOf(ldapx.Child{DN: "uid=ada,ou=people", ObjectClasses: []string{"inetOrgPerson"}, CN: "Ada Lovelace", HasSubordinates: &no, NumSubordinates: -1})
	if p.Sub != "Ada Lovelace" || p.HasChildren || p.Type != "person" {
		t.Fatalf("unexpected %+v", p)
	}
	r := nodeOf(ldapx.Child{DN: "ou=partners", ObjectClasses: []string{"referral", "extensibleObject"}, Refs: []string{"ldap://partners.example.org/ou=partners"}, NumSubordinates: -1})
	if !r.Referral || r.HasChildren || r.Sub != "ldap://partners.example.org/ou=partners" {
		t.Fatalf("unexpected %+v", r)
	}
}

func TestViewOf(t *testing.T) {
	schema := ldapx.ParseSchema("cn=Subschema", []string{
		"( 2.5.4.41 NAME 'name' SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )",
		"( 2.5.4.3 NAME 'cn' SUP name )",
		"( 2.5.4.4 NAME 'sn' SUP name )",
		"( 2.5.4.12 NAME 'title' SUP name )",
		"( 0.9.2342.19200300.100.1.10 NAME 'manager' SYNTAX 1.3.6.1.4.1.1466.115.121.1.12 )",
		"( 0.9.2342.19200300.100.1.60 NAME 'jpegPhoto' SYNTAX 1.3.6.1.4.1.1466.115.121.1.28 )",
		"( 2.5.4.35 NAME 'userPassword' SYNTAX 1.3.6.1.4.1.1466.115.121.1.40 )",
		"( 2.16.840.1.113730.3.1.241 NAME 'displayName' SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 SINGLE-VALUE )",
		"( 2.5.18.1 NAME 'createTimestamp' SYNTAX 1.3.6.1.4.1.1466.115.121.1.24 NO-USER-MODIFICATION USAGE directoryOperation )",
		"( 2.5.4.0 NAME 'objectClass' SYNTAX 1.3.6.1.4.1.1466.115.121.1.38 )",
	}, []string{
		"( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )",
		"( 2.5.6.6 NAME 'person' SUP top STRUCTURAL MUST ( sn $ cn ) MAY userPassword )",
		"( 2.16.840.1.113730.3.2.2 NAME 'inetOrgPerson' SUP person STRUCTURAL MAY ( displayName $ jpegPhoto $ manager $ title ) )",
	})
	raw := &ldapx.RawEntry{DN: "uid=ada,ou=people,dc=example,dc=org", Attributes: []ldapx.RawAttribute{
		{Name: "uid", Values: [][]byte{[]byte("ada")}},
		{Name: "objectClass", Values: [][]byte{[]byte("inetOrgPerson"), []byte("person"), []byte("top")}},
		{Name: "cn", Values: [][]byte{[]byte("Ada Lovelace")}},
		{Name: "sn", Values: [][]byte{[]byte("Lovelace")}},
		{Name: "title", Values: [][]byte{[]byte("Principal engineer")}},
		{Name: "manager", Values: [][]byte{[]byte("uid=grace,ou=people,dc=example,dc=org")}},
		{Name: "userPassword", Values: [][]byte{[]byte("{SSHA}abcdefghijklmnopqrstuvwxyz0123456789")}},
		{Name: "jpegPhoto", Values: [][]byte{append([]byte{0xff, 0xd8}, make([]byte, 14234)...)}},
		{Name: "createTimestamp", Values: [][]byte{[]byte("20261106100000Z")}},
	}}
	v := viewOf(raw, schema, false)
	if v.Title != "Ada Lovelace" || v.Type != "person" || v.Subtitle != "Principal engineer" {
		t.Fatalf("header %q %q %q", v.Title, v.Type, v.Subtitle)
	}
	by := map[string]EntryAttribute{}
	for _, a := range v.Attributes {
		by[a.Name] = a
	}
	if v.Attributes[0].Name != "objectClass" {
		t.Fatal("objectClass comes first")
	}
	if by["manager"].Kind != "dn" || by["jpegPhoto"].Kind != "binary" || by["userPassword"].Kind != "password" || by["cn"].Kind != "text" {
		t.Fatalf("kinds: %+v", by)
	}
	if by["jpegPhoto"].Values[0] != "JPEG image · 14,236 bytes" {
		t.Fatalf("jpeg %q", by["jpegPhoto"].Values[0])
	}
	if got := by["userPassword"].Values[0]; got != "{SSHA} hashed value · 42 bytes" || strings.Contains(got, "abcdef") {
		t.Fatalf("password shown: %q", got)
	}
	if !by["cn"].Required || !by["sn"].Required || by["title"].Required || !by["createTimestamp"].Operational {
		t.Fatal("required/operational flags")
	}
	if !strings.HasPrefix(v.LDIF, "dn: uid=ada,ou=people,dc=example,dc=org\nobjectClass: inetOrgPerson\n") {
		t.Fatalf("LDIF starts wrong:\n%s", v.LDIF)
	}
	if strings.Contains(v.LDIF, "createTimestamp") || !strings.Contains(v.LDIF, "jpegPhoto:: /9gA") {
		t.Fatal("LDIF holds user attributes only, binary as base64")
	}
}

func TestViewOfWithoutSchema(t *testing.T) {
	raw := &ldapx.RawEntry{DN: "cn=admins,ou=groups,dc=example,dc=org", Attributes: []ldapx.RawAttribute{
		{Name: "objectClass", Values: [][]byte{[]byte("groupOfNames")}},
		{Name: "member", Values: [][]byte{[]byte("uid=ada,ou=people,dc=example,dc=org")}},
		{Name: "description", Values: [][]byte{[]byte("Directory administrators")}},
		{Name: "entryUUID", Values: [][]byte{[]byte("809afb97")}},
	}}
	v := viewOf(raw, nil, false)
	if v.Type != "group" || v.Title != "admins" || v.Subtitle != "Directory administrators" {
		t.Fatalf("header %+v", v)
	}
	if v.Attributes[1].Kind != "dn" || !v.Attributes[3].Operational {
		t.Fatalf("fallbacks: %+v", v.Attributes)
	}
}

func TestThousands(t *testing.T) {
	for n, want := range map[int]string{0: "0", 999: "999", 1000: "1,000", 14236: "14,236", 1234567: "1,234,567"} {
		if got := thousands(n); got != want {
			t.Errorf("thousands(%d) = %s", n, got)
		}
	}
}
