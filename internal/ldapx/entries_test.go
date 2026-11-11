package ldapx

import "testing"

func TestEscapeRDNValue(t *testing.T) {
	for in, want := range map[string]string{
		"Ada Lovelace": "Ada Lovelace",
		"Doe, John":    `Doe\, John`,
		"a+b":          `a\+b`,
		`say "hi"`:     `say \"hi\"`,
		`back\slash`:   `back\\slash`,
		"<tag>;x":      `\<tag\>\;x`,
		" leading":     `\ leading`,
		"trailing ":    `trailing\ `,
		"#hash":        `\#hash`,
		"mid#hash":     "mid#hash",
		"nul\x00":      `nul\00`,
		"Zürich":       "Zürich",
		"a=b":          "a=b",
		" ":            `\ `,
	} {
		if got := EscapeRDNValue(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestSplitDNRoundTrips(t *testing.T) {
	for _, v := range []string{"Ada Lovelace", "Doe, John", "a+b", ` leading`, "#hash", `back\slash`} {
		dn := RDN("cn", v) + ",ou=people,dc=example,dc=org"
		attr, value, parent, err := SplitDN(dn)
		if err != nil || attr != "cn" || value != v || parent != "ou=people,dc=example,dc=org" {
			t.Errorf("%q → %q: %q %q %q %v", v, dn, attr, value, parent, err)
		}
	}
	if _, _, _, err := SplitDN("cn=a+uid=b,dc=org"); err == nil {
		t.Error("a multi-valued RDN is refused")
	}
	if _, _, _, err := SplitDN("not a dn"); err == nil {
		t.Error("garbage is refused")
	}
}

func TestSameAndUnderDN(t *testing.T) {
	if !SameDN("UID=Ada, OU=People,dc=example,dc=org", "uid=ada,ou=people,dc=example,dc=org") {
		t.Error("case and spaces don't make another DN")
	}
	if SameDN("uid=ada,dc=org", "uid=alan,dc=org") {
		t.Error("different DNs")
	}
	if !UnderDN("uid=ada,ou=people,dc=org", "ou=people,dc=org") || UnderDN("ou=people,dc=org", "ou=people,dc=org") {
		t.Error("UnderDN is strict")
	}
}

func TestEscapeFilterKeepsUTF8(t *testing.T) {
	if got := EscapeFilter(`Zoë (a*b)\`); got != `Zoë \28a\2ab\29\5c` {
		t.Fatalf("got %q", got)
	}
	if _, err := NewControlAssertion("(cn=" + EscapeFilter("Zoë (x)") + ")"); err != nil {
		t.Fatalf("the filter must compile: %v", err)
	}
}
