package services

import "testing"

func TestUnescapeRDN(t *testing.T) {
	for in, want := range map[string]string{
		"ada":            "ada",
		`Smith\, John`:   "Smith, John",
		`Smith\2C John`:  "Smith, John",
		`a\+b\=c`:        "a+b=c",
		`trailing\`:      `trailing\`,
		`not\zzhex`:      "notzzhex",
		`uid\3Dinside`:   "uid=inside",
		"plain, no esc.": "plain, no esc.",
	} {
		if got := unescapeRDN(in); got != want {
			t.Errorf("unescapeRDN(%q) = %q, want %q", in, got, want)
		}
	}
}
