package ldapx

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/go-ldap/ldap/v3"
)

// writeOp is the Op of a request that changes the directory.
func (s *Session) writeOp() Op {
	return Op{Endpoint: s.Endpoint, Security: s.Security, BindDN: s.BindDN, Timeout: s.Timeout, Stage: StageWrite}
}

// Add creates an entry.
func (s *Session) Add(ctx context.Context, dn string, attrs []RawAttribute) error {
	req := ldap.NewAddRequest(dn, nil)
	for _, a := range attrs {
		vals := make([]string, len(a.Values))
		for i, v := range a.Values {
			vals[i] = string(v)
		}
		req.Attribute(a.Name, vals)
	}
	err := withCtx(ctx, s.Conn, func() error { return s.Conn.Add(req) })
	return Classify(err, s.writeOp()).orNil()
}

// Delete removes a leaf entry.
func (s *Session) Delete(ctx context.Context, dn string) error {
	err := withCtx(ctx, s.Conn, func() error { return s.Conn.Del(ldap.NewDelRequest(dn, nil)) })
	return Classify(err, s.writeOp()).orNil()
}

// Rename gives an entry a new RDN under the same parent and drops the old RDN value
// (deleteoldrdn: 1). newRDN is already escaped, as RDN builds it.
func (s *Session) Rename(ctx context.Context, dn, newRDN string) error {
	err := withCtx(ctx, s.Conn, func() error { return s.Conn.ModifyDN(ldap.NewModifyDNRequest(dn, newRDN, true, "")) })
	return Classify(err, s.writeOp()).orNil()
}

// EscapeRDNValue escapes a value for an RDN (RFC 4514 §2.4): the special characters
// , + " \ < > ; a leading space or #, a trailing space, and NUL.
func EscapeRDNValue(v string) string {
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c == 0:
			b.WriteString(`\00`)
			continue
		case strings.IndexByte(`,+"\<>;`, c) >= 0,
			i == 0 && (c == ' ' || c == '#'),
			i == len(v)-1 && c == ' ':
			b.WriteByte('\\')
		}
		b.WriteByte(c)
	}
	return b.String()
}

// RDN builds "attr=value" with the value escaped.
func RDN(attr, value string) string { return attr + "=" + EscapeRDNValue(value) }

// SplitDN returns the attribute type and the unescaped value of the first RDN, and the parent DN.
// A multi-valued first RDN (cn=a+uid=b) is refused: Kanopa does not rename those.
func SplitDN(dn string) (attr, value, parent string, err error) {
	d, err := ldap.ParseDN(dn)
	if err != nil || len(d.RDNs) == 0 {
		return "", "", "", fmt.Errorf("%q is not a DN", dn)
	}
	if len(d.RDNs[0].Attributes) != 1 {
		return "", "", "", fmt.Errorf("%s has a multi-valued RDN", dn)
	}
	first := d.RDNs[0].Attributes[0]
	return first.Type, first.Value, parentOf(dn), nil
}

// parentOf cuts the first RDN off a DN as written, keeping the parent's spelling.
func parentOf(dn string) string {
	for i := 0; i < len(dn); i++ {
		switch dn[i] {
		case '\\':
			i++
		case ',':
			return strings.TrimSpace(dn[i+1:])
		}
	}
	return ""
}

// SameDN compares two DNs as LDAP does for names: attribute types and values without regard to case.
func SameDN(a, b string) bool {
	if strings.EqualFold(a, b) {
		return true
	}
	da, err1 := ldap.ParseDN(a)
	db, err2 := ldap.ParseDN(b)
	return err1 == nil && err2 == nil && da.EqualFold(db)
}

// UnderDN reports whether dn is strictly below base.
func UnderDN(dn, base string) bool {
	d, err1 := ldap.ParseDN(dn)
	b, err2 := ldap.ParseDN(base)
	return err1 == nil && err2 == nil && b.AncestorOfFold(d)
}

// Found is one search hit for a picker.
type Found struct {
	DN            string
	CN            string
	UID           string
	Mail          string
	Description   string
	ObjectClasses []string
}

// Find searches base's subtree with filter for pickers: the first limit hits sorted by name, and
// how many match in all, counted up to countLimit (more is true beyond it).
//
// The count reads only names (cn, to sort by); the details are read for the hits returned.
func (s *Session) Find(ctx context.Context, base, filter string, limit, countLimit int) (hits []Found, total int, more bool, err error) {
	req := ldap.NewSearchRequest(base, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, s.secs(), false,
		filter, []string{"cn"}, nil)
	entries, truncated, err := s.readAll(ctx, req, 500, countLimit)
	if err != nil {
		return nil, 0, false, Classify(err, s.op())
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].GetAttributeValue("cn")) < strings.ToLower(entries[j].GetAttributeValue("cn"))
	})
	for _, e := range entries[:min(limit, len(entries))] {
		one := ldap.NewSearchRequest(e.DN, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, s.secs(), false,
			"(objectClass=*)", []string{"cn", "uid", "mail", "description", "objectClass"}, nil)
		res, err := keepSearch(ctx, s.Conn, one)
		if err != nil || len(res.Entries) == 0 {
			hits = append(hits, Found{DN: e.DN, CN: e.GetAttributeValue("cn")})
			continue
		}
		d := res.Entries[0]
		hits = append(hits, Found{DN: e.DN, CN: d.GetAttributeValue("cn"), UID: d.GetAttributeValue("uid"), Mail: d.GetAttributeValue("mail"),
			Description: d.GetAttributeValue("description"), ObjectClasses: d.GetAttributeValues("objectClass")})
	}
	return hits, len(entries), truncated, nil
}

// CountChildren counts the entries directly below dn, up to limit (more is true beyond it).
// It reads no attributes.
func (s *Session) CountChildren(ctx context.Context, dn string, limit int) (count int, more bool, err error) {
	req := ldap.NewSearchRequest(dn, ldap.ScopeSingleLevel, ldap.NeverDerefAliases, 0, s.secs(), false,
		"(objectClass=*)", []string{"1.1"}, nil)
	entries, truncated, err := s.readAll(ctx, req, min(max(limit, 1), 1000), limit)
	if err != nil {
		return 0, false, Classify(err, s.op())
	}
	return len(entries), truncated, nil
}

// Referrer is a group that lists a DN, and the attribute that lists it.
type Referrer struct {
	DN            string
	CN            string
	Attr          string // member or uniqueMember
	ObjectClasses []string
}

// Referrers finds the groups under base whose member or uniqueMember holds dn, up to limit.
func (s *Session) Referrers(ctx context.Context, base, dn string, limit int) ([]Referrer, bool, error) {
	var out []Referrer
	more := false
	for _, attr := range []string{"member", "uniqueMember"} {
		req := ldap.NewSearchRequest(base, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, s.secs(), false,
			"("+attr+"="+ldap.EscapeFilter(dn)+")", []string{"cn", "objectClass"}, nil)
		entries, truncated, err := s.readAll(ctx, req, 500, limit)
		if err != nil {
			var le *ldap.Error
			// Servers without uniqueMember in their schema refuse the filter: nothing refers through it.
			if errors.As(err, &le) && attr == "uniqueMember" && (le.ResultCode == ldap.LDAPResultUndefinedAttributeType || le.ResultCode == ldap.LDAPResultInappropriateMatching) {
				continue
			}
			return nil, false, Classify(err, s.op())
		}
		more = more || truncated
		for _, e := range entries {
			out = append(out, Referrer{DN: e.DN, CN: e.GetAttributeValue("cn"), Attr: attr, ObjectClasses: e.GetAttributeValues("objectClass")})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].CN) < strings.ToLower(out[j].CN) })
	return out, more, nil
}
