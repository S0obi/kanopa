package ldapx

import (
	"strings"
	"testing"
)

var testAttrs = []string{
	"( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )",
	"( 2.5.4.3 NAME ( 'cn' 'commonName' ) DESC 'RFC4519: common name(s) for which the entity is known by' SUP name )",
	"( 2.5.4.4 NAME ( 'sn' 'surname' ) SUP name )",
	"( 2.5.4.49 NAME 'distinguishedName' EQUALITY distinguishedNameMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.12 )",
	"( 2.5.4.31 NAME 'member' SUP distinguishedName )",
	"( 0.9.2342.19200300.100.1.60 NAME 'jpegPhoto' SYNTAX 1.3.6.1.4.1.1466.115.121.1.28 )",
	"( 2.16.840.1.113730.3.1.241 NAME 'displayName' SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 SINGLE-VALUE )",
	"( 2.5.18.1 NAME 'createTimestamp' SYNTAX 1.3.6.1.4.1.1466.115.121.1.24 SINGLE-VALUE NO-USER-MODIFICATION USAGE directoryOperation )",
	"( 1.3.6.1.4.1.1466.101.120.16 NAME 'ldapSyntaxes' SYNTAX 1.3.6.1.4.1.1466.115.121.1.54 USAGE directoryOperation X-ORIGIN 'RFC4512' )",
}

var testClasses = []string{
	"( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )",
	"( 2.5.6.6 NAME 'person' DESC 'RFC2256: a person' SUP top STRUCTURAL MUST ( sn $ cn ) MAY ( userPassword $ telephoneNumber ) )",
	"( 2.16.840.1.113730.3.2.2 NAME 'inetOrgPerson' SUP organizationalPerson STRUCTURAL MAY ( displayName $ jpegPhoto ) )",
	"( 2.5.6.7 NAME 'organizationalPerson' SUP person STRUCTURAL MAY ( title $ ou ) )",
	"( 1.3.6.1.4.1.5322.13.1.1 NAME 'namedObject' SUP top AUXILIARY MAY cn )",
}

func TestParseSchema(t *testing.T) {
	s := ParseSchema("cn=Subschema", testAttrs, testClasses)
	if s.AttrCount != len(testAttrs) || s.ClassCount != len(testClasses) {
		t.Fatalf("counts %d/%d", s.AttrCount, s.ClassCount)
	}
	cn := s.Attr("commonName")
	if cn == nil || cn != s.Attr("CN") || cn.Syntax != "1.3.6.1.4.1.1466.115.121.1.15" {
		t.Fatalf("cn should inherit name's syntax without the bound: %+v", cn)
	}
	if s.Attr("member").Syntax != SyntaxDN {
		t.Fatal("member should inherit the DN syntax from distinguishedName")
	}
	if !s.Attr("displayName").SingleValue || s.Attr("cn").SingleValue {
		t.Fatal("single-value flags wrong")
	}
	if !s.Attr("createTimestamp").Operational() || s.Attr("cn").Operational() || !s.Attr("ldapSyntaxes").Operational() {
		t.Fatal("operational flags wrong")
	}
	if s.Attr("jpegPhoto").Syntax != SyntaxJPEG || s.Attr("nope") != nil {
		t.Fatal("lookup")
	}
	if k := s.Class("namedObject").Kind; k != "AUXILIARY" {
		t.Fatalf("kind %s", k)
	}
	req := s.Required([]string{"inetOrgPerson"})
	for _, a := range []string{"cn", "commonname", "sn", "surname", "objectclass"} {
		if !req[a] {
			t.Errorf("%s should be required through the superclasses", a)
		}
	}
	if req["title"] {
		t.Error("title is optional")
	}
}

func TestNilSchemaIsSafe(t *testing.T) {
	var s *Schema
	if s.Attr("cn") != nil || s.Class("top") != nil {
		t.Fatal("a missing schema answers nil")
	}
}

func TestEqualityAndAllowed(t *testing.T) {
	s := ParseSchema("cn=Subschema", testAttrs, testClasses)
	if s.Attr("cn").Equality != "caseIgnoreMatch" || s.Attr("member").Equality != "distinguishedNameMatch" || s.Attr("jpegPhoto").Equality != "" {
		t.Fatal("EQUALITY should be read and inherited from SUP")
	}
	must, may := s.Allowed([]string{"inetOrgPerson", "namedObject"})
	if strings.Join(must, ",") != "sn,cn,objectClass" {
		t.Fatalf("must %v", must)
	}
	if strings.Join(may, ",") != "displayName,jpegPhoto,title,ou,userPassword,telephoneNumber" {
		t.Fatalf("may %v", may)
	}
	var none *Schema
	if m, y := none.Allowed([]string{"top"}); m != nil || y != nil {
		t.Fatal("no schema, nothing allowed")
	}
}

func TestClassList(t *testing.T) {
	s := ParseSchema("cn=Subschema", testAttrs, append(testClasses, "( 9.9.9 NAME 'oldThing' DESC 'Gone' OBSOLETE STRUCTURAL )"))
	var names []string
	for _, c := range s.ClassList() {
		names = append(names, c.Names[0])
	}
	if strings.Join(names, ",") != "inetOrgPerson,namedObject,oldThing,organizationalPerson,person,top" {
		t.Fatalf("classes %v", names)
	}
	if c := s.Class("person"); c.Desc != "RFC2256: a person" || c.Obsolete || !s.Class("oldThing").Obsolete {
		t.Fatalf("desc and obsolete: %+v", c)
	}
}
