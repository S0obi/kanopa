package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The design system's voice rules for what the Go side says people (errors, notices, toasts): plain,
// in contractions, never shouting. The frontend has the same test over its own copy (src/copy.test.ts).
var banned = []struct {
	re  *regexp.Regexp
	why string
}{
	{regexp.MustCompile(`(?i)\bsuccessfully\b`), `say what happened, not that it "successfully" did`},
	{regexp.MustCompile(`(?i)\bplease\b`), "the UI is not asking a favor"},
	{regexp.MustCompile(`(?i)\bcould not\b|\bcannot\b|\bdid not\b|\bdoes not\b|\bwill not\b|\bdo not\b`), "use contractions (couldn't, can't, doesn't)"},
	{regexp.MustCompile(`(?i)\b(simply|leverage|seamless|empower)\b`), "filler: say what it does"},
	{regexp.MustCompile(`!(\s|$)`), "no exclamation marks in system copy"},
	{regexp.MustCompile(`(?i)^error:`), `no "Error:" prefix`},
	{regexp.MustCompile(`\.\.\.(?:[^\w.]|$)`), "a real ellipsis (…), only for something in progress"},
}

// Strings that are not copy: log keys, formats of other languages, an LDAP operator named in a hint, and
// the text of a Go error that Kanopa recognizes (changing it would stop the match).
var notCopy = regexp.MustCompile(`^[a-z0-9_.:/%-]+$|^\W*$|^! needs|^first record does not look like a TLS handshake$`)

func TestGoCopyKeepsTheVoice(t *testing.T) {
	roots := []string{"services", "internal", "main.go"}
	fset := token.NewFileSet()
	checked := 0
	for _, root := range roots {
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				t.Errorf("walking %s: %v", path, err)
				return nil
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			// Test servers and fixtures say nothing to a person.
			if strings.Contains(filepath.ToSlash(path), "internal/fakeldap/") || strings.Contains(filepath.ToSlash(path), "internal/testldap/") {
				return nil
			}
			f, perr := parser.ParseFile(fset, path, nil, 0)
			if perr != nil {
				t.Errorf("%s: %v", path, perr)
				return nil
			}
			ast.Inspect(f, func(n ast.Node) bool {
				lit, ok := n.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				s, uerr := strconv.Unquote(lit.Value)
				if uerr != nil || notCopy.MatchString(s) || !strings.Contains(s, " ") {
					return true
				}
				checked++
				for _, b := range banned {
					if b.re.MatchString(s) {
						t.Errorf("%s: %q: %s", fset.Position(lit.Pos()), s, b.why)
					}
				}
				return true
			})
			return nil
		})
	}
	if checked < 100 {
		t.Fatalf("only %d sentences scanned: the scan is not finding the copy", checked)
	}
}
