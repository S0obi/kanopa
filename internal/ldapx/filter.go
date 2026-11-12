package ldapx

import (
	"fmt"
	"strings"
	"unicode"
)

// FilterError says where and why a search filter is not valid (RFC 4515).
type FilterError struct {
	// Pos is the 0-based character index the problem points at; len(filter) for a filter that ends too soon.
	Pos int
	Msg string
	// Suggestion is a corrected filter when the fix is obvious, such as wrapping a bare (uid=ada) in parentheses.
	Suggestion string
}

func (e *FilterError) Error() string { return e.Msg }

// CheckFilter reports whether s is a valid LDAP search filter, and where it goes wrong when not.
// Spaces around the filter are ignored; inside it they are part of values. It checks the shape
// and the escaping only: the server decides whether an attribute exists.
func CheckFilter(s string) *FilterError {
	p := &filterParser{r: []rune(s)}
	p.space()
	if p.i >= len(p.r) {
		return &FilterError{Pos: 0, Msg: "Type a filter, such as (objectClass=*)."}
	}
	if p.peek() != '(' {
		err := &FilterError{Pos: p.i, Msg: "A filter is wrapped in parentheses, like (uid=ada)."}
		if wrapped := "(" + strings.TrimSpace(s) + ")"; CheckFilter(wrapped) == nil {
			err.Suggestion = wrapped
		}
		return err
	}
	if err := p.filter(); err != nil {
		return err
	}
	p.space()
	if p.i < len(p.r) {
		return p.fail("Unexpected text after the filter. Combine filters with (&…) or (|…).")
	}
	return nil
}

type filterParser struct {
	r []rune
	i int
}

func (p *filterParser) peek() rune {
	if p.i < len(p.r) {
		return p.r[p.i]
	}
	return 0
}

func (p *filterParser) fail(msg string) *FilterError { return &FilterError{Pos: p.i, Msg: msg} }

func (p *filterParser) space() {
	for p.i < len(p.r) && unicode.IsSpace(p.r[p.i]) {
		p.i++
	}
}

// filter parses "(" filtercomp ")".
func (p *filterParser) filter() *FilterError {
	open := p.i
	p.i++ // (
	switch p.peek() {
	case '&', '|':
		op := p.peek()
		p.i++
		n := 0
		for p.peek() == '(' {
			if err := p.filter(); err != nil {
				return err
			}
			n++
		}
		if n == 0 {
			return p.fail(fmt.Sprintf("%c needs at least one filter after it, like (%c(uid=ada)(uid=alan)).", op, op))
		}
	case '!':
		p.i++
		if p.peek() != '(' {
			return p.fail("! needs one filter after it, like (!(uid=ada)).")
		}
		if err := p.filter(); err != nil {
			return err
		}
	default:
		if err := p.item(); err != nil {
			return err
		}
	}
	if p.peek() != ')' || p.i >= len(p.r) {
		if p.i >= len(p.r) {
			return p.fail(fmt.Sprintf("Missing ) to close the ( at position %d.", open+1))
		}
		return p.fail(fmt.Sprintf("Expected ) to close the ( at position %d.", open+1))
	}
	p.i++ // )
	return nil
}

func isAttrChar(r rune) bool {
	return r == '-' || r == '.' || r == ';' || r == '_' || (r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)))
}

// item parses a simple, present, substring or extensible match.
func (p *filterParser) item() *FilterError {
	start := p.i
	for p.i < len(p.r) && isAttrChar(p.r[p.i]) {
		p.i++
	}
	named := p.i > start
	switch c := p.peek(); {
	case c == ':':
		return p.extensible()
	case !named:
		if p.i >= len(p.r) {
			return p.fail("Expected an attribute name, like uid.")
		}
		return p.fail(fmt.Sprintf("Expected an attribute name here, like uid, not %q.", string(c)))
	case c == '=':
		p.i++
		return p.value(true)
	case (c == '~' || c == '>' || c == '<') && p.i+1 < len(p.r) && p.r[p.i+1] == '=':
		p.i += 2
		return p.value(false)
	}
	if p.i >= len(p.r) {
		return p.fail("Expected = after the attribute name.")
	}
	return p.fail("Expected = (or ~=, >=, <=) after the attribute name.")
}

// extensible parses [:dn][:rule]:= after an optional attribute name; p is at the first ':'.
func (p *filterParser) extensible() *FilterError {
	for p.peek() == ':' {
		p.i++
		if p.peek() == '=' {
			p.i++
			return p.value(false)
		}
		word := p.i
		for p.i < len(p.r) && (isAttrChar(p.r[p.i])) {
			p.i++
		}
		if p.i == word {
			return p.fail("Expected dn, a matching rule or := here.")
		}
	}
	return p.fail("Expected := in an extensible match.")
}

// value parses an assertion value up to the closing ")", checking the \XX escapes. A * is a
// wildcard only after =.
func (p *filterParser) value(wildcards bool) *FilterError {
	for p.i < len(p.r) {
		switch c := p.r[p.i]; c {
		case ')':
			return nil
		case '(':
			return p.fail("A ( inside a value is written \\28.")
		case '*':
			if !wildcards {
				return p.fail("* works only after =. Write a literal * as \\2a.")
			}
		case 0:
			return p.fail("A NUL character inside a value is written \\00.")
		case '\\':
			if p.i+2 >= len(p.r) || !isHex(p.r[p.i+1]) || !isHex(p.r[p.i+2]) {
				return p.fail("A \\ is followed by two hex digits, like \\28 for (. Write a literal \\ as \\5c.")
			}
			p.i += 2
		}
		p.i++
	}
	return nil // the caller reports the missing )
}

func isHex(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}
