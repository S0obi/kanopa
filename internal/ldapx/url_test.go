package ldapx

import "testing"

func TestParseURL(t *testing.T) {
	cases := []struct {
		in   string
		want Endpoint
		ok   bool
	}{
		{"ldaps://ldap.example.org:636", Endpoint{"ldaps", "ldap.example.org", 636}, true},
		{"ldaps://ldap.example.org", Endpoint{"ldaps", "ldap.example.org", 636}, true},
		{"ldap://localhost", Endpoint{"ldap", "localhost", 389}, true},
		{"LDAP://Host.Example.org:10389/", Endpoint{"ldap", "Host.Example.org", 10389}, true},
		{"  ldap://127.0.0.1:389  ", Endpoint{"ldap", "127.0.0.1", 389}, true},
		{"ldap://[::1]:389", Endpoint{"ldap", "::1", 389}, true},
		{"ldap.example.org", Endpoint{}, false},
		{"http://ldap.example.org", Endpoint{}, false},
		{"ldap://", Endpoint{}, false},
		{"ldap://host:0", Endpoint{}, false},
		{"ldap://host:70000", Endpoint{}, false},
		{"ldap://host/dc=example,dc=org", Endpoint{}, false},
	}
	for _, c := range cases {
		got, err := ParseURL(c.in)
		if (err == nil) != c.ok {
			t.Errorf("ParseURL(%q) err = %v, want ok=%v", c.in, err, c.ok)
			continue
		}
		if c.ok && got != c.want {
			t.Errorf("ParseURL(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestEndpointURL(t *testing.T) {
	ep := Endpoint{"ldap", "::1", 389}
	if got := ep.URL(); got != "ldap://[::1]:389" {
		t.Fatalf("URL() = %q", got)
	}
	if !ep.IsLocal() {
		t.Fatal("::1 should be local")
	}
}

func TestSecurityFor(t *testing.T) {
	ldaps := Endpoint{"ldaps", "h", 636}
	ldap := Endpoint{"ldap", "h", 389}
	if s, err := SecurityFor(ldaps, SecurityNone); err != nil || s != SecurityLDAPS {
		t.Errorf("ldaps scheme should force LDAPS, got %q %v", s, err)
	}
	if s, err := SecurityFor(ldap, SecurityStartTLS); err != nil || s != SecurityStartTLS {
		t.Errorf("got %q %v", s, err)
	}
	if s, err := SecurityFor(ldap, SecurityNone); err != nil || s != SecurityNone {
		t.Errorf("got %q %v", s, err)
	}
	if _, err := SecurityFor(ldap, SecurityLDAPS); err == nil {
		t.Error("ldap:// with LDAPS should be refused")
	}
}
