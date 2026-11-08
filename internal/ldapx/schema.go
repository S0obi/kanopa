package ldapx

import (
	"context"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// Well-known attribute syntaxes (RFC 4517 and common extensions).
const (
	SyntaxDN               = "1.3.6.1.4.1.1466.115.121.1.12"
	SyntaxNameAndOptionalU = "1.3.6.1.4.1.1466.115.121.1.34"
	SyntaxOctetString      = "1.3.6.1.4.1.1466.115.121.1.40"
	SyntaxJPEG             = "1.3.6.1.4.1.1466.115.121.1.28"
	SyntaxCertificate      = "1.3.6.1.4.1.1466.115.121.1.8"
	SyntaxCertList         = "1.3.6.1.4.1.1466.115.121.1.9"
	SyntaxCertPair         = "1.3.6.1.4.1.1466.115.121.1.10"
	SyntaxBinary           = "1.3.6.1.4.1.1466.115.121.1.5"
	SyntaxAudio            = "1.3.6.1.4.1.1466.115.121.1.4"
	SyntaxFax              = "1.3.6.1.4.1.1466.115.121.1.23"
)

// AttributeType is one attributeTypes definition, with SUP already resolved.
type AttributeType struct {
	OID         string
	Names       []string
	Sup         string
	Syntax      string
	Equality    string // the EQUALITY matching rule; empty when values can't be compared
	SingleValue bool
	NoUserMod   bool
	Usage       string // userApplications (default) or a directory/DSA operation usage
}

// Operational reports whether the attribute is kept by the server rather than the person.
func (a *AttributeType) Operational() bool {
	return (a.Usage != "" && a.Usage != "userApplications") || a.NoUserMod
}

// ObjectClass is one objectClasses definition.
type ObjectClass struct {
	OID   string
	Names []string
	Sup   []string
	Kind  string // STRUCTURAL, AUXILIARY or ABSTRACT
	Must  []string
	May   []string
}

// Schema is what the server publishes in its subschema subentry.
type Schema struct {
	DN         string
	attrs      map[string]*AttributeType // by lower-case name and OID
	classes    map[string]*ObjectClass
	AttrCount  int
	ClassCount int
}

// Attr returns the definition of an attribute by name or OID, or nil.
func (s *Schema) Attr(name string) *AttributeType {
	if s == nil {
		return nil
	}
	return s.attrs[strings.ToLower(name)]
}

// Class returns the definition of an object class by name or OID, or nil.
func (s *Schema) Class(name string) *ObjectClass {
	if s == nil {
		return nil
	}
	return s.classes[strings.ToLower(name)]
}

// Required lists the attributes the given object classes (and their superclasses) require, lower-cased.
func (s *Schema) Required(classes []string) map[string]bool {
	out := map[string]bool{}
	seen := map[string]bool{}
	var walk func(name string)
	walk = func(name string) {
		oc := s.Class(name)
		if oc == nil || seen[oc.OID] {
			return
		}
		seen[oc.OID] = true
		for _, m := range oc.Must {
			out[strings.ToLower(m)] = true
			if a := s.Attr(m); a != nil {
				for _, n := range a.Names {
					out[strings.ToLower(n)] = true
				}
			}
		}
		for _, sup := range oc.Sup {
			walk(sup)
		}
	}
	for _, c := range classes {
		walk(c)
	}
	return out
}

// Allowed lists the attributes the given object classes (and their superclasses) require or allow,
// by first name, required ones first, each once.
func (s *Schema) Allowed(classes []string) (must, may []string) {
	seen := map[string]bool{}
	visited := map[string]bool{}
	var walk func(name string)
	add := func(list *[]string, names []string) {
		for _, n := range names {
			a := s.Attr(n)
			key := strings.ToLower(n)
			if a != nil {
				key = a.OID
				if len(a.Names) > 0 {
					n = a.Names[0]
				}
			}
			if !seen[key] {
				seen[key] = true
				*list = append(*list, n)
			}
		}
	}
	var mustDefs, mayDefs [][]string
	walk = func(name string) {
		oc := s.Class(name)
		if oc == nil || visited[oc.OID] {
			return
		}
		visited[oc.OID] = true
		mustDefs = append(mustDefs, oc.Must)
		mayDefs = append(mayDefs, oc.May)
		for _, sup := range oc.Sup {
			walk(sup)
		}
	}
	for _, c := range classes {
		walk(c)
	}
	for _, m := range mustDefs {
		add(&must, m)
	}
	for _, m := range mayDefs {
		add(&may, m)
	}
	return must, may
}

// ParseSchema reads attributeTypes and objectClasses definitions (RFC 4512 §4.1).
func ParseSchema(dn string, attributeTypes, objectClasses []string) *Schema {
	s := &Schema{DN: dn, attrs: map[string]*AttributeType{}, classes: map[string]*ObjectClass{}}
	for _, def := range attributeTypes {
		f := parseDefinition(def)
		if f.oid == "" {
			continue
		}
		a := &AttributeType{OID: f.oid, Names: f.list("NAME"), Sup: f.one("SUP"), Syntax: syntaxOID(f.one("SYNTAX")),
			Equality:    f.one("EQUALITY"),
			SingleValue: f.flag("SINGLE-VALUE"), NoUserMod: f.flag("NO-USER-MODIFICATION"), Usage: f.one("USAGE")}
		s.AttrCount++
		s.attrs[strings.ToLower(a.OID)] = a
		for _, n := range a.Names {
			s.attrs[strings.ToLower(n)] = a
		}
	}
	// Inherit SYNTAX, EQUALITY and USAGE from SUP, following chains.
	for _, a := range s.attrs {
		for depth, sup := 0, a.Sup; (a.Syntax == "" || a.Equality == "") && sup != "" && depth < 16; depth++ {
			p := s.attrs[strings.ToLower(sup)]
			if p == nil {
				break
			}
			if a.Syntax == "" {
				a.Syntax = p.Syntax
			}
			if a.Equality == "" {
				a.Equality = p.Equality
			}
			if a.Usage == "" {
				a.Usage = p.Usage
			}
			sup = p.Sup
		}
	}
	for _, def := range objectClasses {
		f := parseDefinition(def)
		if f.oid == "" {
			continue
		}
		kind := "STRUCTURAL"
		switch {
		case f.flag("AUXILIARY"):
			kind = "AUXILIARY"
		case f.flag("ABSTRACT"):
			kind = "ABSTRACT"
		}
		oc := &ObjectClass{OID: f.oid, Names: f.list("NAME"), Sup: f.list("SUP"), Kind: kind, Must: f.list("MUST"), May: f.list("MAY")}
		s.ClassCount++
		s.classes[strings.ToLower(oc.OID)] = oc
		for _, n := range oc.Names {
			s.classes[strings.ToLower(n)] = oc
		}
	}
	return s
}

// syntaxOID drops a length bound: "1.3.6.1.4.1.1466.115.121.1.15{256}".
func syntaxOID(v string) string {
	if i := strings.IndexByte(v, '{'); i >= 0 {
		return v[:i]
	}
	return v
}

// definition holds the fields of one schema description: keyword → values.
type definition struct {
	oid    string
	fields map[string][]string
}

func (d definition) list(k string) []string { return d.fields[k] }
func (d definition) flag(k string) bool     { _, ok := d.fields[k]; return ok }
func (d definition) one(k string) string {
	if v := d.fields[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// token is one piece of a schema description; quoted strings are never keywords.
type token struct {
	v      string
	quoted bool
}

func (t token) is(s string) bool { return !t.quoted && t.v == s }

// parseDefinition reads "( oid NAME ( 'a' 'b' ) SUP top MUST ( x $ y ) SINGLE-VALUE ... )".
func parseDefinition(s string) definition {
	toks := tokenize(s)
	d := definition{fields: map[string][]string{}}
	if len(toks) < 2 || !toks[0].is("(") {
		return d
	}
	d.oid = toks[1].v
	for i := 2; i < len(toks); i++ {
		t := toks[i]
		if t.quoted || !isKeyword(t.v) {
			continue // stray token: skip it rather than misread the rest
		}
		key := strings.ToUpper(t.v)
		next := i + 1
		switch {
		case next >= len(toks) || toks[next].is(")") || (!toks[next].quoted && isKeyword(toks[next].v) && !takesValue(key)):
			d.fields[key] = nil // a flag: SINGLE-VALUE, STRUCTURAL…
		case toks[next].is("("):
			var vals []string
			j := next + 1
			for ; j < len(toks) && !toks[j].is(")"); j++ {
				if !toks[j].is("$") {
					vals = append(vals, toks[j].v)
				}
			}
			d.fields[key] = vals
			i = j
		default:
			d.fields[key] = []string{toks[next].v}
			i = next
		}
	}
	return d
}

var keywords = map[string]bool{
	"NAME": true, "DESC": true, "OBSOLETE": true, "SUP": true, "EQUALITY": true, "ORDERING": true, "SUBSTR": true,
	"SYNTAX": true, "SINGLE-VALUE": true, "COLLECTIVE": true, "NO-USER-MODIFICATION": true, "USAGE": true,
	"ABSTRACT": true, "STRUCTURAL": true, "AUXILIARY": true, "MUST": true, "MAY": true,
}

// Keywords followed by a value; the others are flags.
var valued = map[string]bool{"NAME": true, "DESC": true, "SUP": true, "EQUALITY": true, "ORDERING": true, "SUBSTR": true,
	"SYNTAX": true, "USAGE": true, "MUST": true, "MAY": true}

func isKeyword(t string) bool {
	u := strings.ToUpper(t)
	return keywords[u] || strings.HasPrefix(u, "X-")
}

func takesValue(key string) bool { return valued[key] || strings.HasPrefix(key, "X-") }

func tokenize(s string) []token {
	var out []token
	for i := 0; i < len(s); {
		c := s[i]
		switch c {
		case ' ', '\t', '\n', '\r':
			i++
		case '(', ')', '$':
			out = append(out, token{v: string(c)})
			i++
		case '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return append(out, token{v: s[i+1:], quoted: true})
			}
			out = append(out, token{v: s[i+1 : i+1+j], quoted: true})
			i += j + 2
		default:
			j := i
			for j < len(s) && !strings.ContainsRune(" \t\r\n()$'", rune(s[j])) {
				j++
			}
			out = append(out, token{v: s[i:j]})
			i = j
		}
	}
	return out
}

// ReadSchema reads the subschema subentry named in the root DSE.
func (s *Session) ReadSchema(ctx context.Context, subschemaDN string) (*Schema, error) {
	if subschemaDN == "" {
		subschemaDN = "cn=Subschema"
	}
	op := Op{Endpoint: s.Endpoint, Security: s.Security, BindDN: s.BindDN, Timeout: s.Timeout, Stage: StageRead}
	req := ldap.NewSearchRequest(subschemaDN, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, int(s.Timeout/time.Second), false,
		"(objectClass=subschema)", []string{"attributeTypes", "objectClasses"}, nil)
	res, err := searchCtx(ctx, s.Conn, req)
	if err != nil {
		return nil, Classify(err, op)
	}
	if len(res.Entries) == 0 {
		return ParseSchema(subschemaDN, nil, nil), nil
	}
	e := res.Entries[0]
	return ParseSchema(subschemaDN, e.GetAttributeValues("attributeTypes"), e.GetAttributeValues("objectClasses")), nil
}
