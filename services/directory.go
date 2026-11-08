package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/S0obi/kanopa/internal/ldapx"
	"github.com/S0obi/kanopa/internal/ldif"
)

// DirectoryService reads the directory behind an open connection: the tree, entries, memberships.
type DirectoryService struct {
	log  *slog.Logger
	live *registry
}

// NewDirectoryService returns the directory service over the connections cs opens.
func NewDirectoryService(log *slog.Logger, cs *ConnectionService) *DirectoryService {
	if log == nil {
		log = slog.Default()
	}
	return &DirectoryService{log: log, live: cs.live}
}

// Failure is a read that did not work, worded for the UI. Lost means the connection is gone:
// the UI offers Reconnect.
type Failure struct {
	Title   string `json:"title"`
	Message string `json:"message"`
	Code    int    `json:"code"`
	Lost    bool   `json:"lost"`
}

// childLimit bounds how many children of one entry Kanopa reads.
const childLimit = 20_000

// TreeNode is one entry in the tree.
type TreeNode struct {
	DN          string `json:"dn"`
	RDN         string `json:"rdn"`
	Type        string `json:"type"` // root | ou | person | group | server | entry
	Sub         string `json:"sub"`  // a description or name shown after the RDN
	HasChildren bool   `json:"hasChildren"`
	Count       int    `json:"count"` // children, -1 when unknown
	Referral    bool   `json:"referral"`
}

// TreeResult is a list of nodes: the roots, or one page of children.
type TreeResult struct {
	Nodes     []TreeNode `json:"nodes"`
	More      string     `json:"more"`      // token for the next page, empty when done
	Total     int        `json:"total"`     // children of the parent read, -1 when unknown
	Truncated bool       `json:"truncated"` // the parent has more than 20,000 children; only those are listed
	ElapsedMs int64      `json:"elapsedMs"`
	Failure   *Failure   `json:"failure"`
}

// EntryAttribute is one attribute as the entry view shows it.
type EntryAttribute struct {
	Name        string   `json:"name"`
	Values      []string `json:"values"` // text, or a description such as "JPEG image · 14,236 bytes"
	IDs         []string `json:"ids"`    // binary and password values: a fingerprint of each, to name it in a change
	Kind        string   `json:"kind"`   // text | dn | binary | password
	Operational bool     `json:"operational"`
	SingleValue bool     `json:"singleValue"`
	Required    bool     `json:"required"`
}

// EntryView is one entry, ready to show.
type EntryView struct {
	DN            string             `json:"dn"`
	Title         string             `json:"title"`
	Subtitle      string             `json:"subtitle"`
	Type          string             `json:"type"`
	ObjectClasses []string           `json:"objectClasses"`
	Attributes    []EntryAttribute   `json:"attributes"`
	Allowed       []AllowedAttribute `json:"allowed"` // attributes the object classes allow that the entry lacks
	LDIF          string             `json:"ldif"`
	Referral      bool               `json:"referral"`
	ElapsedMs     int64              `json:"elapsedMs"`
	Failure       *Failure           `json:"failure"`
}

// AllowedAttribute is an attribute that can be added to an entry.
type AllowedAttribute struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"` // text | dn | password
	SingleValue bool   `json:"singleValue"`
	Required    bool   `json:"required"`
}

// RelatedEntry is a group (Member of) or a member.
type RelatedEntry struct {
	DN          string `json:"dn"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description"`
}

// RelatedResult lists related entries.
type RelatedResult struct {
	Entries   []RelatedEntry `json:"entries"`
	Truncated bool           `json:"truncated"` // more than were read
	Failure   *Failure       `json:"failure"`
}

const memberOfLimit = 1000

// session returns the open session, or a Failure asking to reconnect.
func (d *DirectoryService) session(id string) (*liveSession, *Failure) {
	if l := d.live.get(id); l != nil {
		return l, nil
	}
	return nil, &Failure{Title: "Not connected.", Message: "This connection is closed. Reconnect to keep working.", Lost: true}
}

// fail words an error. A connection that died is dropped, and the UI offers Reconnect.
func (d *DirectoryService) fail(l *liveSession, err error) *Failure {
	var le *ldapx.Error
	if !errors.As(err, &le) {
		return &Failure{Title: "Read failed.", Message: err.Error()}
	}
	lost := le.Code == ldapx.CodeServerDown || le.Code == 52 || l.Conn.IsClosing()
	if !lost {
		return &Failure{Title: le.Title, Message: le.Text(), Code: le.Code}
	}
	d.live.drop(l.id, l)
	d.log.Info("connection lost", "id", l.id, "code", le.Code)
	return &Failure{Title: fmt.Sprintf("Connection to %s lost.", l.Endpoint.Host), Code: 52, Lost: true,
		Message: "The server stopped answering. Reconnect to keep working. Server is unavailable (52)"}
}

// Roots returns the top of the tree: the naming contexts (or the configured base DN) and the schema entry.
func (d *DirectoryService) Roots(id string) TreeResult {
	l, f := d.session(id)
	if f != nil {
		return TreeResult{Failure: f, Total: -1}
	}
	var dns []string
	if l.baseDN != "" {
		dns = append(dns, l.baseDN)
	}
	for _, nc := range l.namingContexts {
		if !strings.EqualFold(nc, l.baseDN) {
			dns = append(dns, nc)
		}
	}
	out := TreeResult{Total: -1, Nodes: []TreeNode{}}
	for _, dn := range dns {
		out.Nodes = append(out.Nodes, TreeNode{DN: dn, RDN: dn, Type: "root", HasChildren: true, Count: -1})
	}
	if l.subschemaDN != "" {
		out.Nodes = append(out.Nodes, TreeNode{DN: l.subschemaDN, RDN: l.subschemaDN, Type: "server", Sub: "Schema", Count: -1})
	}
	return out
}

// Children returns one page of the entries below dn: the connection's page size, starting at
// the token of the previous page ("" for the first). The first page reads every child from the
// server in one paged search (up to 20,000) and keeps them, so "Show N more" knows N exactly.
func (d *DirectoryService) Children(ctx context.Context, id, dn, more string) TreeResult {
	l, f := d.session(id)
	if f != nil {
		return TreeResult{Failure: f, Total: -1}
	}
	start := time.Now()
	offset := 0
	list := l.cachedChildren(dn)
	if more != "" {
		n, err := strconv.Atoi(more)
		if err != nil || n < 0 || list == nil {
			return TreeResult{Total: -1, Failure: &Failure{Title: "Page expired.", Message: "Collapse and expand the entry to read its children again."}}
		}
		offset = n
	} else {
		l.paged.Lock()
		children, truncated, err := l.Children(ctx, dn, l.pageSize, childLimit, l.referrals)
		l.paged.Unlock()
		if err != nil {
			return TreeResult{Failure: d.fail(l, err), Total: -1}
		}
		list = &childList{nodes: make([]TreeNode, 0, len(children)), truncated: truncated}
		for _, c := range children {
			list.nodes = append(list.nodes, nodeOf(c))
		}
		l.cacheChildren(dn, list)
	}
	end := min(offset+l.pageSize, len(list.nodes))
	offset = min(offset, end)
	out := TreeResult{Nodes: list.nodes[offset:end], Total: len(list.nodes), Truncated: list.truncated}
	if end < len(list.nodes) {
		out.More = strconv.Itoa(end)
	}
	out.ElapsedMs = time.Since(start).Milliseconds()
	return out
}

func nodeOf(c ldapx.Child) TreeNode {
	n := TreeNode{DN: c.DN, RDN: firstRDN(c.DN), Type: typeOf(c.ObjectClasses, false), Count: c.NumSubordinates}
	n.Referral = hasClass(c.ObjectClasses, "referral")
	switch {
	case n.Referral:
		n.Type = "entry"
		if len(c.Refs) > 0 {
			n.Sub = c.Refs[0]
		}
	case c.Description != "":
		n.Sub = c.Description
	case c.DisplayName != "":
		n.Sub = c.DisplayName
	case c.CN != "" && !strings.HasPrefix(strings.ToLower(n.RDN), "cn="):
		n.Sub = c.CN
	}
	switch {
	case n.Referral:
		n.HasChildren = false
	case c.HasSubordinates != nil:
		n.HasChildren = *c.HasSubordinates
	case c.NumSubordinates >= 0:
		n.HasChildren = c.NumSubordinates > 0
	default:
		// The server does not say: containers may have children, leaves may not.
		n.HasChildren = n.Type == "ou" || n.Type == "root" || n.Type == "entry"
	}
	return n
}

func hasClass(classes []string, name string) bool {
	for _, c := range classes {
		if strings.EqualFold(c, name) {
			return true
		}
	}
	return false
}

// typeOf maps object classes to the tile Kanopa draws for them.
func typeOf(classes []string, root bool) string {
	if root {
		return "root"
	}
	has := func(names ...string) bool {
		for _, n := range names {
			if hasClass(classes, n) {
				return true
			}
		}
		return false
	}
	switch {
	case has("dcObject", "organization", "domain"):
		return "root"
	case has("organizationalUnit", "container", "nsContainer"):
		return "ou"
	case has("groupOfNames", "groupOfUniqueNames", "posixGroup", "group", "groupOfMembers"):
		return "group"
	case has("inetOrgPerson", "person", "organizationalPerson", "user", "posixAccount"):
		if has("account") && !has("person", "inetOrgPerson") {
			return "entry"
		}
		return "person"
	case has("device", "ipHost", "computer", "subschema", "subentry"):
		return "server"
	}
	return "entry"
}

// firstRDN returns the leftmost RDN of a DN, respecting escaped commas.
func firstRDN(dn string) string {
	for i := 0; i < len(dn); i++ {
		switch dn[i] {
		case '\\':
			i++
		case ',':
			return strings.TrimSpace(dn[:i])
		}
	}
	return strings.TrimSpace(dn)
}

// Entry reads one entry and describes each attribute for display, with its LDIF.
func (d *DirectoryService) Entry(ctx context.Context, id, dn string) EntryView {
	l, f := d.session(id)
	if f != nil {
		return EntryView{DN: dn, Failure: f}
	}
	start := time.Now()
	raw, err := l.ReadEntry(ctx, dn, l.referrals)
	if err != nil {
		return EntryView{DN: dn, Failure: d.fail(l, err)}
	}
	v := viewOf(raw, l.schema, l.isRoot(raw.DN))
	v.ElapsedMs = time.Since(start).Milliseconds()
	return v
}

func (l *liveSession) isRoot(dn string) bool {
	if strings.EqualFold(dn, l.baseDN) {
		return true
	}
	for _, nc := range l.namingContexts {
		if strings.EqualFold(dn, nc) {
			return true
		}
	}
	return false
}

// Attributes known to hold DNs, for servers that do not publish their schema.
var dnAttrs = map[string]bool{"member": true, "uniquemember": true, "owner": true, "manager": true, "seealso": true,
	"roleoccupant": true, "secretary": true, "creatorsname": true, "modifiersname": true, "subschemasubentry": true,
	"entrydn": true, "memberof": true, "distinguishedname": true, "aliasedobjectname": true}

var binarySyntaxes = map[string]bool{ldapx.SyntaxJPEG: true, ldapx.SyntaxCertificate: true, ldapx.SyntaxCertList: true,
	ldapx.SyntaxCertPair: true, ldapx.SyntaxBinary: true, ldapx.SyntaxAudio: true, ldapx.SyntaxFax: true, ldapx.SyntaxOctetString: true}

// Attributes the server keeps, for servers that do not publish their schema.
var operationalAttrs = map[string]bool{"createtimestamp": true, "modifytimestamp": true, "creatorsname": true, "modifiersname": true,
	"entryuuid": true, "entrycsn": true, "entrydn": true, "structuralobjectclass": true, "subschemasubentry": true,
	"hassubordinates": true, "numsubordinates": true, "memberof": true, "pwdchangedtime": true, "contextcsn": true}

func viewOf(raw *ldapx.RawEntry, schema *ldapx.Schema, root bool) EntryView {
	classes := raw.Get("objectClass")
	v := EntryView{DN: raw.DN, ObjectClasses: nonNil(classes), Type: typeOf(classes, root), Attributes: []EntryAttribute{}}
	v.Referral = hasClass(classes, "referral")
	required := map[string]bool{}
	if schema != nil {
		required = schema.Required(classes)
	}

	var ldifAttrs []ldif.Attribute
	var oc *EntryAttribute
	for _, a := range raw.Attributes {
		def := schema.Attr(a.Name)
		lower := strings.ToLower(a.Name)
		ea := EntryAttribute{Name: a.Name, Kind: kindOf(a.Name, def), Required: required[lower]}
		if def != nil {
			ea.Operational, ea.SingleValue = def.Operational(), def.SingleValue
		} else {
			ea.Operational = operationalAttrs[lower]
		}
		for _, b := range a.Values {
			if ea.Kind == "text" && !utf8.Valid(b) {
				ea.Kind = "binary"
			}
		}
		for _, b := range a.Values {
			ea.Values = append(ea.Values, display(ea.Kind, b))
			if ea.Kind == "binary" || ea.Kind == "password" {
				ea.IDs = append(ea.IDs, valueID(b))
			}
		}
		if !ea.Operational {
			ldifAttrs = append(ldifAttrs, ldif.Attribute{Name: a.Name, Values: a.Values})
		}
		if strings.EqualFold(a.Name, "objectClass") {
			cp := ea
			oc = &cp
			continue
		}
		v.Attributes = append(v.Attributes, ea)
	}
	// objectClass first, as the design draws it; then the server's order.
	if oc != nil {
		v.Attributes = append([]EntryAttribute{*oc}, v.Attributes...)
	}
	for i, a := range ldifAttrs {
		if strings.EqualFold(a.Name, "objectClass") && i > 0 {
			ldifAttrs = append(append([]ldif.Attribute{a}, ldifAttrs[:i]...), ldifAttrs[i+1:]...)
			break
		}
	}
	v.LDIF = ldif.Entry(raw.DN, ldifAttrs)
	v.Allowed = allowedOf(raw, schema, classes)

	rdn := firstRDN(raw.DN)
	v.Title = rdn
	if i := strings.IndexByte(rdn, '='); i >= 0 {
		v.Title = rdn[i+1:]
	}
	first := func(names ...string) string {
		for _, n := range names {
			if vals := raw.Get(n); len(vals) > 0 && vals[0] != "" {
				return vals[0]
			}
		}
		return ""
	}
	if t := first("displayName", "cn"); t != "" && v.Type == "person" {
		v.Title = t
	}
	if v.Type == "person" {
		v.Subtitle = joinNonEmpty(" · ", first("title"), first("departmentNumber", "ou"), first("mail"))
	} else {
		v.Subtitle = first("description")
	}
	if v.Referral {
		v.Subtitle = strings.Join(raw.Get("ref"), " ")
	}
	return v
}

// kindOf says how an attribute's values are shown and edited.
func kindOf(name string, def *ldapx.AttributeType) string {
	lower := strings.ToLower(name)
	switch {
	case strings.Contains(lower, "password"):
		return "password"
	case def != nil && (def.Syntax == ldapx.SyntaxDN || def.Syntax == ldapx.SyntaxNameAndOptionalU), def == nil && dnAttrs[lower]:
		return "dn"
	case def != nil && binarySyntaxes[def.Syntax]:
		return "binary"
	}
	return "text"
}

// valueID fingerprints a value Kanopa does not show, so a change can name it.
func valueID(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:12])
}

// allowedOf lists what the entry's object classes allow and it lacks. Binary attributes are left
// out: Kanopa only deletes binary values.
func allowedOf(raw *ldapx.RawEntry, schema *ldapx.Schema, classes []string) []AllowedAttribute {
	out := []AllowedAttribute{}
	must, may := schema.Allowed(classes)
	add := func(names []string, required bool) {
		for _, n := range names {
			if len(raw.Get(n)) > 0 || hasAlias(raw, schema.Attr(n)) {
				continue
			}
			def := schema.Attr(n)
			if def != nil && def.Operational() {
				continue
			}
			kind := kindOf(n, def)
			if kind == "binary" {
				continue
			}
			out = append(out, AllowedAttribute{Name: n, Kind: kind, SingleValue: def != nil && def.SingleValue, Required: required})
		}
	}
	add(must, true)
	add(may, false)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Required != out[j].Required {
			return out[i].Required
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// hasAlias reports whether the entry holds the attribute under another of its names.
func hasAlias(raw *ldapx.RawEntry, def *ldapx.AttributeType) bool {
	if def == nil {
		return false
	}
	for _, n := range def.Names {
		if len(raw.Get(n)) > 0 {
			return true
		}
	}
	return false
}

func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// display turns a value into what the entry view shows. Passwords and binary values are described, never shown.
func display(kind string, b []byte) string {
	switch kind {
	case "password":
		if len(b) > 2 && b[0] == '{' {
			if end := strings.IndexByte(string(b), '}'); end > 0 {
				return fmt.Sprintf("%s hashed value · %s bytes", string(b[:end+1]), thousands(len(b)))
			}
		}
		return fmt.Sprintf("Hidden value · %s bytes", thousands(len(b)))
	case "binary":
		return fmt.Sprintf("%s · %s bytes", binaryKind(b), thousands(len(b)))
	}
	return string(b)
}

func binaryKind(b []byte) string {
	switch {
	case len(b) > 2 && b[0] == 0xff && b[1] == 0xd8:
		return "JPEG image"
	case len(b) > 7 && string(b[1:4]) == "PNG":
		return "PNG image"
	case len(b) > 1 && b[0] == 0x30 && b[1] >= 0x80:
		return "DER data"
	}
	return "Binary value"
}

// thousands writes n with comma separators: 14236 → "14,236".
func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// MemberOf lists the groups that list dn as a member, searched from the connection's base DN.
func (d *DirectoryService) MemberOf(ctx context.Context, id, dn string) RelatedResult {
	l, f := d.session(id)
	if f != nil {
		return RelatedResult{Failure: f}
	}
	uid := ""
	if rdn := firstRDN(dn); strings.HasPrefix(strings.ToLower(rdn), "uid=") {
		uid = rdn[4:]
	}
	l.paged.Lock()
	groups, truncated, err := l.MemberOf(ctx, l.baseDN, dn, uid, memberOfLimit)
	l.paged.Unlock()
	if err != nil {
		return RelatedResult{Failure: d.fail(l, err)}
	}
	out := RelatedResult{Entries: []RelatedEntry{}, Truncated: truncated}
	for _, g := range groups {
		name := g.CN
		if name == "" {
			name = firstRDN(g.DN)
		}
		out.Entries = append(out.Entries, RelatedEntry{DN: g.DN, Name: name, Type: typeOf(g.ObjectClasses, false), Description: g.Description})
	}
	return out
}

// Ping checks that the connection still answers. It returns nil when it does.
func (d *DirectoryService) Ping(ctx context.Context, id string) *Failure {
	l, f := d.session(id)
	if f != nil {
		return f
	}
	if _, err := l.ReadRootDSE(ctx); err != nil {
		return d.fail(l, err)
	}
	return nil
}
