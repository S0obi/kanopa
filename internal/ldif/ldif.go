// Package ldif writes entries as LDIF (RFC 2849).
package ldif

import (
	"encoding/base64"
	"strings"
	"unicode/utf8"
)

// Width is where lines fold: the RFC recommends at most 76 columns.
const Width = 76

// Attribute is one attribute with its raw values, in the order to write them.
type Attribute struct {
	Name   string
	Values [][]byte
}

// Entry writes one entry: "dn: …" then one line per value, folded, base64 where the RFC requires.
func Entry(dn string, attrs []Attribute) string {
	var b strings.Builder
	line(&b, "dn", []byte(dn))
	for _, a := range attrs {
		for _, v := range a.Values {
			line(&b, a.Name, v)
		}
	}
	return b.String()
}

func line(b *strings.Builder, name string, v []byte) {
	var l string
	if Safe(v) {
		l = name + ": " + string(v)
	} else {
		l = name + ":: " + base64.StdEncoding.EncodeToString(v)
	}
	if len(v) == 0 {
		l = name + ":"
	}
	fold(b, l)
}

// fold writes l in lines of at most Width bytes; continuation lines start with one space.
// It never splits a UTF-8 sequence (DN lines may hold UTF-8 when written as base64-free text).
func fold(b *strings.Builder, l string) {
	first := true
	for len(l) > 0 {
		max := Width
		if !first {
			max = Width - 1
			b.WriteByte(' ')
		}
		if len(l) <= max {
			b.WriteString(l)
			break
		}
		cut := max
		for cut > 0 && !utf8.RuneStart(l[cut]) {
			cut--
		}
		b.WriteString(l[:cut])
		b.WriteByte('\n')
		l = l[cut:]
		first = false
	}
	b.WriteByte('\n')
}

// Safe reports whether v can be written as a plain value (RFC 2849 SAFE-STRING):
// ASCII without NUL, LF or CR, not starting with space, ':' or '<', not ending with space.
func Safe(v []byte) bool {
	if len(v) == 0 {
		return true
	}
	if v[0] == ' ' || v[0] == ':' || v[0] == '<' || v[len(v)-1] == ' ' {
		return false
	}
	for _, c := range v {
		if c == 0 || c == '\n' || c == '\r' || c > 0x7f {
			return false
		}
	}
	return true
}
