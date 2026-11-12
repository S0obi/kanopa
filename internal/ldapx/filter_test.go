package ldapx

import (
	"strings"
	"testing"
)

func TestCheckFilterAcceptsValidFilters(t *testing.T) {
	for _, f := range []string{
		"(uid=ada)", "  (uid=ada)  ", "(objectClass=*)", "(cn=*ada*)", "(cn=a*b*c)", "(&(a=1)(b=2))", "(|(a=1)(b=2)(c=*))",
		"(!(a=1))", "(&(objectClass=inetOrgPerson)(|(uid=ada*)(mail=ada*))(!(title=*)))", "(age>=18)", "(age<=18)", "(cn~=ada)",
		`(memberOf=cn=x\2cy,dc=example)`, "(cn:dn:=ada)", "(:caseExactMatch:=ada)", "(cn:2.5.13.5:=ada)", "(uid=)", "(2.5.4.3=ada)",
		"(cn;lang-en=ada)", "(cn=Zoë)",
	} {
		if err := CheckFilter(f); err != nil {
			t.Errorf("%q should be valid, got %q at %d", f, err.Msg, err.Pos)
		}
	}
}

func TestCheckFilterPointsAtTheProblem(t *testing.T) {
	for _, tc := range []struct {
		filter string
		pos    int
		msg    string
	}{
		{"", 0, "Type a filter"},
		{"(&(uid=ada)", 11, "Missing ) to close the ( at position 1"},
		{"(uid=ada", 8, "Missing ) to close the ( at position 1"},
		{"(&(a=1)(|(b=2)(c=3))", 20, "Missing ) to close the ( at position 1"},
		{"(uid ada)", 4, "Expected = (or ~=, >=, <=)"},
		{"(uid", 4, "Expected ="},
		{"(&)", 2, "& needs at least one filter"},
		{"(!uid=ada)", 2, "! needs one filter"},
		{"(=ada)", 1, "Expected an attribute name here"},
		{"(uid=a(b)", 6, "A ( inside a value"},
		{`(cn=\zz)`, 4, "followed by two hex digits"},
		{`(cn=\2)`, 4, "followed by two hex digits"},
		{"(age>=*)", 6, "* works only after ="},
		{"(uid=ada))", 9, "Unexpected text after the filter"},
		{"(uid=ada)(cn=x)", 9, "Unexpected text after the filter"},
		{"(cn:=)", -1, ""},
		{"(cn:", 4, "Expected dn, a matching rule or :="},
	} {
		err := CheckFilter(tc.filter)
		if tc.pos < 0 {
			if err != nil {
				t.Errorf("%q should be valid, got %q", tc.filter, err.Msg)
			}
			continue
		}
		if err == nil {
			t.Errorf("%q should be refused", tc.filter)
			continue
		}
		if err.Pos != tc.pos || !strings.Contains(err.Msg, tc.msg) {
			t.Errorf("%q: got %q at %d, want %q at %d", tc.filter, err.Msg, err.Pos, tc.msg, tc.pos)
		}
	}
}

func TestCheckFilterSuggestsParentheses(t *testing.T) {
	err := CheckFilter("uid=ada")
	if err == nil || err.Pos != 0 || err.Suggestion != "(uid=ada)" {
		t.Fatalf("got %+v", err)
	}
	err = CheckFilter("  cn=*ada*  ")
	if err == nil || err.Suggestion != "(cn=*ada*)" {
		t.Fatalf("got %+v", err)
	}
	if err := CheckFilter("hello world"); err == nil || err.Suggestion != "" {
		t.Fatalf("nothing to suggest for %+v", err)
	}
}

func TestCheckFilterCountsCharactersNotBytes(t *testing.T) {
	err := CheckFilter("(cn=Zoë")
	if err == nil || err.Pos != 7 {
		t.Fatalf("got %+v, want position 7 (characters)", err)
	}
}

// Everything CheckFilter accepts, go-ldap must compile too: the filter is what is sent.
func TestCheckedFiltersCompile(t *testing.T) {
	for _, f := range []string{"(uid=ada)", "(&(objectClass=inetOrgPerson)(|(uid=ada*)(mail=ada*))(!(title=*)))", "(age>=18)", "(cn:dn:=ada)", `(memberOf=cn=x\2cy,dc=example)`} {
		if CheckFilter(f) != nil {
			t.Fatalf("%q refused", f)
		}
		if err := compiles(f); err != nil {
			t.Errorf("go-ldap can't compile %q: %v", f, err)
		}
	}
}

func compiles(f string) error {
	_, err := ldapCompile(f)
	return err
}
