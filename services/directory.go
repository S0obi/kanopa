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
	// ServerLimit: the server's own size limit ended the read, so the list is what it returned.
	ServerLimit bool     `json:"serverLimit"`
	ElapsedMs   int64    `json:"elapsedMs"`
	Failure     *Failure `json:"failure"`
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
	// MemberAttr is, for a group, the attribute that lists its members: member, uniqueMember, or
	// memberUid for a posixGroup (it lists uids, not DNs).
	MemberAttr string `json:"memberAttr"`
	// UID is the entry's uid, for a person: what a posixGroup's memberUid holds. Empty when it has none.
	UID string `json:"uid"`
}

// FindResult is one search for a picker: the first hits and how many match in all.
type FindResult struct {
	Entries []RelatedEntry `json:"entries"`
	Total   int            `json:"total"`
	More    bool           `json:"more"` // more match than were counted
	Filter  string         `json:"filter"`
	Base    string         `json:"base"`
	Failure *Failure       `json:"failure"`
}

// Picker limits: hits shown, and matches counted for the total.
const (
	findHits  = 8
	findCount = 1000
)

// memberAttrOf is the attribute a group lists its members in, by its object classes.
func memberAttrOf(classes []string) string {
	switch {
	case hasClass(classes, "groupOfNames"), hasClass(classes, "groupOfMembers"):
		return "member"
	case hasClass(classes, "groupOfUniqueNames"):
		return "uniqueMember"
	case hasClass(classes, "posixGroup"):
		return "memberUid"
	}
	return ""
}

// Find searches the connection's base DN for a picker: kind "people" (inetOrgPerson by uid, cn
// or mail; posixAccount too) or "groups" (groupOfNames, groupOfUniqueNames and posixGroup by cn).
// q needs 2 characters.
func (d *DirectoryService) Find(ctx context.Context, id, kind, q string) FindResult {
	l, f := d.session(id)
	if f != nil {
		return FindResult{Failure: f, Entries: []RelatedEntry{}}
	}
	q = strings.TrimSpace(q)
	out := FindResult{Entries: []RelatedEntry{}, Base: l.baseDN}
	e := ldapx.EscapeFilter(q)
	switch kind {
	case "people":
		out.Filter = "(&(|(objectClass=inetOrgPerson)(objectClass=posixAccount))(|(uid=" + e + "*)(cn=*" + e + "*)(mail=" + e + "*)))"
	case "groups":
		out.Filter = "(&(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))(cn=*" + e + "*))"
	default:
		out.Failure = &Failure{Title: "Search failed.", Message: fmt.Sprintf("Kanopa can't search for %q.", kind)}
		return out
	}
	if len([]rune(q)) < 2 {
		return out
	}
	l.paged.Lock()
	hits, total, more, err := l.Find(ctx, l.baseDN, out.Filter, findHits, findCount)
	l.paged.Unlock()
	if err != nil {
		out.Failure = d.fail(l, err)
		return out
	}
	out.Total, out.More = total, more
	for _, h := range hits {
		name := h.CN
		if name == "" {
			name = firstRDN(h.DN)
		}
		desc := h.Mail
		if kind == "groups" || desc == "" {
			desc = h.Description
		}
		out.Entries = append(out.Entries, RelatedEntry{DN: h.DN, Name: name, Type: typeOf(h.ObjectClasses, false), Description: desc,
			MemberAttr: memberAttrOf(h.ObjectClasses), UID: h.UID})
	}
	return out
}

// CountResult is how many entries lie directly below an entry.
type CountResult struct {
	Count   int      `json:"count"`
	More    bool     `json:"more"` // more than were counted
	Failure *Failure `json:"failure"`
}

// childCountLimit bounds the count the Delete dialog asks for.
const childCountLimit = childLimit

// CountChildren counts the entries directly below dn, reading no attributes: what the Delete
// dialog says when the tree has not read them.
func (d *DirectoryService) CountChildren(ctx context.Context, id, dn string) CountResult {
	l, f := d.session(id)
	if f != nil {
		return CountResult{Failure: f}
	}
	l.paged.Lock()
	n, more, err := l.CountChildren(ctx, dn, childCountLimit)
	l.paged.Unlock()
	if err != nil {
		return CountResult{Failure: d.fail(l, err)}
	}
	return CountResult{Count: n, More: more}
}

// ClassInfo is one object class of the server's schema, as the New entry form offers it: what it
// requires and allows, superclasses included.
type ClassInfo struct {
	Name string             `json:"name"`
	Kind string             `json:"kind"` // STRUCTURAL | AUXILIARY | ABSTRACT
	Desc string             `json:"desc"`
	Must []AllowedAttribute `json:"must"` // objectClass left out
	May  []AllowedAttribute `json:"may"`
}

// ClassesResult lists the object classes Kanopa can create entries with.
type ClassesResult struct {
	Classes []ClassInfo `json:"classes"`
	Failure *Failure    `json:"failure"`
}

// ObjectClasses lists the structural and auxiliary object classes of the server's schema, with the
// attributes each requires and allows. Abstract and obsolete classes are left out.
func (d *DirectoryService) ObjectClasses(id string) ClassesResult {
	l, f := d.session(id)
	if f != nil {
		return ClassesResult{Failure: f, Classes: []ClassInfo{}}
	}
	out := ClassesResult{Classes: []ClassInfo{}}
	if l.schema == nil {
		out.Failure = &Failure{Title: "Schema not read.", Message: "The server didn't share its schema, so Kanopa can't list its object classes."}
		return out
	}
	info := func(names []string, required bool) []AllowedAttribute {
		list := []AllowedAttribute{}
		for _, n := range names {
			if strings.EqualFold(n, "objectClass") {
				continue
			}
			def := l.schema.Attr(n)
			if def != nil && def.Operational() {
				continue
			}
			list = append(list, AllowedAttribute{Name: n, Kind: kindOf(n, def), SingleValue: def != nil && def.SingleValue, Required: required})
		}
		return list
	}
	for _, c := range l.schema.ClassList() {
		if c.Kind == "ABSTRACT" || c.Obsolete || len(c.Names) == 0 {
			continue
		}
		must, may := l.schema.Allowed([]string{c.Names[0]})
		out.Classes = append(out.Classes, ClassInfo{Name: c.Names[0], Kind: c.Kind, Desc: c.Desc, Must: info(must, true), May: info(may, false)})
	}
	return out
}

// Referrers lists the groups under the base DN whose member or uniqueMember holds dn, or whose
// memberUid holds the entry's uid (unless another entry shares it), with the attribute that holds
// it: what a rename or a delete with cleanup updates.
func (d *DirectoryService) Referrers(ctx context.Context, id, dn string) RelatedResult {
	l, f := d.session(id)
	if f != nil {
		return RelatedResult{Failure: f, Entries: []RelatedEntry{}}
	}
	uid := d.uidOf(ctx, l, dn)
	l.paged.Lock()
	refs, truncated, err := l.Referrers(ctx, l.baseDN, dn, uid, memberOfLimit)
	l.paged.Unlock()
	if err != nil {
		return RelatedResult{Failure: d.fail(l, err), Entries: []RelatedEntry{}}
	}
	out := RelatedResult{Entries: []RelatedEntry{}, Truncated: truncated}
	for _, r := range refs {
		name := r.CN
		if name == "" {
			name = firstRDN(r.DN)
		}
		out.Entries = append(out.Entries, RelatedEntry{DN: r.DN, Name: name, Type: typeOf(r.ObjectClasses, false), MemberAttr: r.Attr, UID: uidIf(r.Attr, uid)})
	}
	return out
}

// uidIf is the uid a referrer lists, when it lists one.
func uidIf(attr, uid string) string {
	if attr == "memberUid" {
		return uid
	}
	return ""
}

// uidOf is the entry's uid: its RDN value when it is named by uid, else its first uid value.
// Empty when it has none or can't be read: the groups that list it by DN are still found.
func (d *DirectoryService) uidOf(ctx context.Context, l *liveSession, dn string) string {
	if rdn := firstRDN(dn); strings.HasPrefix(strings.ToLower(rdn), "uid=") {
		return unescapeRDN(rdn[4:])
	}
	l.paged.Lock()
	raw, err := l.ReadEntry(ctx, dn, l.referrals)
	l.paged.Unlock()
	if err != nil || raw == nil {
		return ""
	}
	if v := raw.Get("uid"); len(v) > 0 {
		return v[0]
	}
	return ""
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
		children, cut, err := l.Children(ctx, dn, l.pageSize, childLimit, l.referrals)
		l.paged.Unlock()
		if err != nil {
			return TreeResult{Failure: d.fail(l, err), Total: -1}
		}
		list = &childList{nodes: make([]TreeNode, 0, len(children)), truncated: cut != ldapx.NotCut, serverLimit: cut == ldapx.CutByServer}
		for _, c := range children {
			list.nodes = append(list.nodes, nodeOf(c))
		}
		l.cacheChildren(dn, list)
	}
	end := min(offset+l.pageSize, len(list.nodes))
	offset = min(offset, end)
	out := TreeResult{Nodes: list.nodes[offset:end], Total: len(list.nodes), Truncated: list.truncated, ServerLimit: list.serverLimit}
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
	// A posixGroup lists the uid, whatever the entry is named: read it from the entry when the RDN is not the uid.
	uid := d.uidOf(ctx, l, dn)
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
		out.Entries = append(out.Entries, RelatedEntry{DN: g.DN, Name: name, Type: typeOf(g.ObjectClasses, false), Description: g.Description,
			MemberAttr: memberAttrOf(g.ObjectClasses)})
	}
	return out
}

// unescapeRDN undoes RFC 4514 escaping in an RDN value: a backslash and a comma give a comma, and a backslash and 2C give a comma too.
func unescapeRDN(v string) string {
	if !strings.Contains(v, `\`) {
		return v
	}
	var out []byte
	for i := 0; i < len(v); i++ {
		if v[i] != '\\' || i+1 >= len(v) {
			out = append(out, v[i])
			continue
		}
		if i+2 < len(v) {
			if n, err := strconv.ParseUint(v[i+1:i+3], 16, 8); err == nil {
				out = append(out, byte(n))
				i += 2
				continue
			}
		}
		i++
		out = append(out, v[i])
	}
	return string(out)
}

// UIDMatch is what one memberUid value stands for: the first entry that carries the uid, and how
// many do. Matches is 0 when none does.
type UIDMatch struct {
	UID     string `json:"uid"`
	DN      string `json:"dn"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Matches int    `json:"matches"`
}

// UIDResult answers ResolveUIDs.
type UIDResult struct {
	Matches []UIDMatch `json:"matches"`
	Failure *Failure   `json:"failure"`
}

// maxResolve bounds how many uids one call looks up.
const maxResolve = 500

// ResolveUIDs finds the entry each uid stands for, under the base DN: a posixGroup lists its members
// by uid. The answer has one match for each uid asked, in the order asked. A uid nothing carries has
// Matches 0.
func (d *DirectoryService) ResolveUIDs(ctx context.Context, id string, uids []string) UIDResult {
	l, f := d.session(id)
	if f != nil {
		return UIDResult{Failure: f, Matches: []UIDMatch{}}
	}
	if len(uids) > maxResolve {
		uids = uids[:maxResolve]
	}
	l.paged.Lock()
	found, err := l.ResolveUIDs(ctx, l.baseDN, uids)
	l.paged.Unlock()
	if err != nil {
		return UIDResult{Failure: d.fail(l, err), Matches: []UIDMatch{}}
	}
	out := UIDResult{Matches: make([]UIDMatch, 0, len(found))}
	for _, m := range found {
		um := UIDMatch{UID: m.UID, Matches: len(m.Entries)}
		if len(m.Entries) > 0 {
			e := m.Entries[0]
			um.DN = e.DN
			um.Name = e.CN
			if um.Name == "" {
				um.Name = firstRDN(e.DN)
			}
			um.Type = typeOf(e.ObjectClasses, false)
		}
		out.Matches = append(out.Matches, um)
	}
	return out
}

// GIDResult answers GIDCheck.
type GIDResult struct {
	Next    int      `json:"next"`    // the next free gidNumber
	TakenBy []string `json:"takenBy"` // posixGroups that already use the asked gidNumber
	Failure *Failure `json:"failure"`
}

// GIDCheck suggests the next free gidNumber for a new posixGroup (above every number in use, and
// at least 1000), and names the posixGroups that already use gid when gid is more than 0.
func (d *DirectoryService) GIDCheck(ctx context.Context, id string, gid int) GIDResult {
	l, f := d.session(id)
	if f != nil {
		return GIDResult{Failure: f, TakenBy: []string{}}
	}
	l.paged.Lock()
	next, taken, err := l.GIDInfo(ctx, l.baseDN, gid)
	l.paged.Unlock()
	if err != nil {
		return GIDResult{Failure: d.fail(l, err), TakenBy: []string{}}
	}
	if taken == nil {
		taken = []string{}
	}
	return GIDResult{Next: next, TakenBy: taken}
}

// PosixGroup is a posixGroup offered as the primary group of a new account.
type PosixGroup struct {
	CN  string `json:"cn"`
	GID int    `json:"gid"`
}

// POSIXResult answers POSIXInfo.
type POSIXResult struct {
	NextUID    int          `json:"nextUid"`    // the next free uidNumber
	UIDTakenBy []string     `json:"uidTakenBy"` // accounts that already use the asked uidNumber
	Groups     []PosixGroup `json:"groups"`     // every posixGroup, by name
	Failure    *Failure     `json:"failure"`
}

// POSIXInfo suggests the next free uidNumber for a new posixAccount (above every number in use, and
// at least 1000), names the accounts that already use uid when uid is more than 0, and lists the
// posixGroups the account can have as its primary group.
func (d *DirectoryService) POSIXInfo(ctx context.Context, id string, uid int) POSIXResult {
	l, f := d.session(id)
	if f != nil {
		return POSIXResult{Failure: f, UIDTakenBy: []string{}, Groups: []PosixGroup{}}
	}
	l.paged.Lock()
	info, err := l.POSIXInfo(ctx, l.baseDN, uid)
	l.paged.Unlock()
	if err != nil {
		return POSIXResult{Failure: d.fail(l, err), UIDTakenBy: []string{}, Groups: []PosixGroup{}}
	}
	out := POSIXResult{NextUID: info.NextUID, UIDTakenBy: info.UIDTakenBy, Groups: make([]PosixGroup, 0, len(info.Groups))}
	if out.UIDTakenBy == nil {
		out.UIDTakenBy = []string{}
	}
	for _, g := range info.Groups {
		out.Groups = append(out.Groups, PosixGroup{CN: g.CN, GID: g.GID})
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
