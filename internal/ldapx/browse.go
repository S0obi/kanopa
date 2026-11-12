package ldapx

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// Attributes the tree needs for each child: what it is, what to show next to it, whether it has children.
var childAttrs = []string{"objectClass", "cn", "ou", "description", "displayName", "ref", "hasSubordinates", "numSubordinates"}

// Child is one entry under a parent, as the tree shows it.
type Child struct {
	DN              string
	ObjectClasses   []string
	Description     string
	CN              string
	DisplayName     string
	Refs            []string // set for a referral entry
	HasSubordinates *bool    // nil when the server does not say
	NumSubordinates int      // -1 when the server does not say
}

// ReferralMode is how a search treats referral objects.
type ReferralMode int

const (
	// ReferralsAsEntries returns referral objects as ordinary entries (ManageDsaIT).
	ReferralsAsEntries ReferralMode = iota
	// ReferralsIgnored drops continuation references.
	ReferralsIgnored
)

func (m ReferralMode) controls() []ldap.Control {
	if m == ReferralsAsEntries {
		return []ldap.Control{ldap.NewControlManageDsaIT(false)}
	}
	return nil
}

func (s *Session) op() Op {
	return Op{Endpoint: s.Endpoint, Security: s.Security, BindDN: s.BindDN, Timeout: s.Timeout, Stage: StageRead}
}

func (s *Session) secs() int { return int(s.Timeout / time.Second) }

// Children reads every entry directly below dn, up to limit, in pages of pageSize (the paged
// results control). cut says whether, and why, it stopped before the end. Many servers (OpenLDAP
// among them) keep one paged search per connection, so callers must not run two paged searches
// at once on a session. On a server without paging the read is one plain search.
func (s *Session) Children(ctx context.Context, dn string, pageSize, limit int, mode ReferralMode) (children []Child, cut Cut, err error) {
	req := ldap.NewSearchRequest(dn, ldap.ScopeSingleLevel, ldap.NeverDerefAliases, 0, s.secs(), false,
		"(objectClass=*)", childAttrs, mode.controls())
	r, err := s.readBounded(ctx, req, max(pageSize, 1), limit)
	if err != nil {
		return nil, NotCut, Classify(err, s.op())
	}
	children = make([]Child, 0, len(r.Entries))
	for _, e := range r.Entries {
		children = append(children, childOf(e))
	}
	return children, r.Cut, nil
}

// Child describes the entry as the tree lists it.
func (e *RawEntry) Child() Child {
	attrs := map[string][]string{}
	for _, a := range e.Attributes {
		attrs[a.Name] = e.Get(a.Name)
	}
	return childOf(ldap.NewEntry(e.DN, attrs))
}

func childOf(e *ldap.Entry) Child {
	c := Child{DN: e.DN, ObjectClasses: e.GetAttributeValues("objectClass"), Description: e.GetAttributeValue("description"),
		CN: e.GetAttributeValue("cn"), DisplayName: e.GetAttributeValue("displayName"), Refs: e.GetAttributeValues("ref"), NumSubordinates: -1}
	if v := e.GetAttributeValue("hasSubordinates"); v != "" {
		b := strings.EqualFold(v, "TRUE")
		c.HasSubordinates = &b
	}
	if v := e.GetAttributeValue("numSubordinates"); v != "" {
		n := 0
		for _, r := range v {
			if r < '0' || r > '9' {
				n = -1
				break
			}
			n = n*10 + int(r-'0')
		}
		c.NumSubordinates = n
	}
	return c
}

// RawAttribute is an attribute as the server returned it.
type RawAttribute struct {
	Name   string
	Values [][]byte
}

// RawEntry is an entry with every attribute, user and operational, as raw bytes in server order.
type RawEntry struct {
	DN         string
	Attributes []RawAttribute
}

// Get returns the values of an attribute (case-insensitive), as strings.
func (e *RawEntry) Get(name string) []string {
	for _, a := range e.Attributes {
		if strings.EqualFold(a.Name, name) {
			out := make([]string, len(a.Values))
			for i, v := range a.Values {
				out[i] = string(v)
			}
			return out
		}
	}
	return nil
}

// ReadEntry reads one entry with its user and operational attributes.
func (s *Session) ReadEntry(ctx context.Context, dn string, mode ReferralMode) (*RawEntry, error) {
	req := ldap.NewSearchRequest(dn, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, s.secs(), false,
		"(objectClass=*)", []string{"*", "+"}, mode.controls())
	res, err := keepSearch(ctx, s.Conn, req)
	if err != nil {
		return nil, Classify(err, s.op())
	}
	if len(res.Entries) == 0 {
		return nil, newErr(32, "Entry not found.", "The server has no entry at "+dn+". It may have been renamed or deleted.", nil)
	}
	e := res.Entries[0]
	out := &RawEntry{DN: e.DN}
	for _, a := range e.Attributes {
		out.Attributes = append(out.Attributes, RawAttribute{Name: a.Name, Values: a.ByteValues})
	}
	return out, nil
}

// Group is a group that lists an entry as a member.
type Group struct {
	DN            string
	CN            string
	Description   string
	ObjectClasses []string
}

// MemberOf finds the groups under base whose member, uniqueMember or memberUid holds the entry.
// It works without the memberOf overlay. At most limit groups are returned, sorted by name.
// It runs a paged search: see Children.
func (s *Session) MemberOf(ctx context.Context, base, dn, uid string, limit int) (groups []Group, truncated bool, err error) {
	filter := "(|(member=" + ldap.EscapeFilter(dn) + ")(uniqueMember=" + ldap.EscapeFilter(dn) + ")"
	if uid != "" {
		filter += "(memberUid=" + ldap.EscapeFilter(uid) + ")"
	}
	filter += ")"
	req := ldap.NewSearchRequest(base, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, s.secs(), false,
		filter, []string{"cn", "description", "objectClass"}, nil)
	entries, truncated, err := s.readAll(ctx, req, 500, limit)
	if err != nil {
		return nil, false, Classify(err, s.op())
	}
	groups = make([]Group, 0, len(entries))
	for _, e := range entries {
		groups = append(groups, Group{DN: e.DN, CN: e.GetAttributeValue("cn"), Description: e.GetAttributeValue("description"),
			ObjectClasses: e.GetAttributeValues("objectClass")})
	}
	sort.Slice(groups, func(i, j int) bool { return strings.ToLower(groups[i].CN) < strings.ToLower(groups[j].CN) })
	return groups, truncated, nil
}

// Cut says why a bounded read stopped before the end of the results.
type Cut int

const (
	// NotCut: every match was read.
	NotCut Cut = iota
	// CutByKanopa: Kanopa's own limit was reached; the server has more.
	CutByKanopa
	// CutByServer: the server's size limit ended the search (result code 4). What was read is kept.
	CutByServer
)

// Read is the entries of one bounded search, and whether and why it stopped early.
type Read struct {
	Entries []*ldap.Entry
	Cut     Cut
}

// readBounded reads the matches of req up to limit. With the paged results control it reads them
// pageSize at a time; on a server without that control it runs one plain search, bounded by
// limit. A search the server's own size limit ended (code 4) keeps the entries it returned.
func (s *Session) readBounded(ctx context.Context, req *ldap.SearchRequest, pageSize, limit int) (Read, error) {
	if s.NoPaging {
		return readUnpaged(ctx, s.Conn, req, limit)
	}
	return readPaged(ctx, s.Conn, req, pageSize, limit)
}

// readAll is readBounded for callers that only need to know that more exist.
func (s *Session) readAll(ctx context.Context, req *ldap.SearchRequest, pageSize, limit int) ([]*ldap.Entry, bool, error) {
	r, err := s.readBounded(ctx, req, pageSize, limit)
	return r.Entries, r.Cut != NotCut, err
}

// sizeLimited reports whether err is the server's "size limit exceeded" (4).
func sizeLimited(err error) bool {
	var le *ldap.Error
	return errors.As(err, &le) && le.ResultCode == ldap.LDAPResultSizeLimitExceeded
}

// readUnpaged runs one plain search asking for one entry more than limit, to tell "exactly
// limit" from "more than limit".
func readUnpaged(ctx context.Context, c *ldap.Conn, req *ldap.SearchRequest, limit int) (Read, error) {
	r := *req
	if r.SizeLimit == 0 || r.SizeLimit > limit+1 {
		r.SizeLimit = limit + 1
	}
	res, err := keepSearch(ctx, c, &r)
	if err != nil && (!sizeLimited(err) || res == nil) {
		return Read{}, err
	}
	out := Read{Entries: res.Entries}
	switch {
	case len(out.Entries) > limit:
		out.Entries, out.Cut = out.Entries[:limit], CutByKanopa
	case err != nil:
		out.Cut = CutByServer
	}
	return out, nil
}

// readPaged runs a paged search to the end, or until limit entries are read. When it stops
// early it abandons the paged search on the server (an empty page with the cookie), so the
// connection is ready for the next one.
func readPaged(ctx context.Context, c *ldap.Conn, req *ldap.SearchRequest, pageSize, limit int) (Read, error) {
	var out []*ldap.Entry
	var cookie []byte
	base := req.Controls
	for {
		paging := ldap.NewControlPaging(uint32(min(max(pageSize, 1), 1<<20))) //nolint:gosec // G115: clamped to 1..1,048,576
		paging.SetCookie(cookie)
		req.Controls = append(append([]ldap.Control{}, base...), paging)
		res, err := keepSearch(ctx, c, req)
		if err != nil && (!sizeLimited(err) || res == nil) {
			return Read{}, err
		}
		out = append(out, res.Entries...)
		if err != nil {
			// The server's own size limit ended the search: no cookie to continue with.
			if len(out) > limit {
				return Read{Entries: out[:limit], Cut: CutByKanopa}, nil
			}
			return Read{Entries: out, Cut: CutByServer}, nil
		}
		ctrl, ok := ldap.FindControl(res.Controls, ldap.ControlTypePaging).(*ldap.ControlPaging)
		if !ok || len(ctrl.Cookie) == 0 {
			if len(out) > limit {
				return Read{Entries: out[:limit], Cut: CutByKanopa}, nil
			}
			return Read{Entries: out}, nil
		}
		if len(out) >= limit {
			stop := ldap.NewControlPaging(0)
			stop.SetCookie(ctrl.Cookie)
			req.Controls = append(append([]ldap.Control{}, base...), stop)
			_, _ = c.Search(req)
			return Read{Entries: out[:limit], Cut: CutByKanopa}, nil
		}
		cookie = ctrl.Cookie
	}
}

// keepSearch searches on a long-lived session. When ctx ends it stops waiting for the answer at once
// and leaves the connection open for the next request; the server's late replies are dropped. A silent
// server is bounded by the request's time limit (plus a short grace), as the connection's own timeout
// used to: a search that gets no answer fails as a timeout instead of waiting for ever.
func keepSearch(ctx context.Context, c *ldap.Conn, req *ldap.SearchRequest) (*ldap.SearchResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c.IsClosing() {
		return nil, ldap.NewError(ldap.ErrorNetwork, errors.New("ldap: connection closed"))
	}
	wait := time.Duration(req.TimeLimit)*time.Second + 2*time.Second
	if req.TimeLimit <= 0 {
		wait = 30 * time.Second
	}
	sctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	r := c.SearchAsync(sctx, req, 256)
	res := &ldap.SearchResult{}
	for r.Next() {
		if e := r.Entry(); e != nil {
			res.Entries = append(res.Entries, e)
		}
		if ref := r.Referral(); ref != "" {
			res.Referrals = append(res.Referrals, ref)
		}
		res.Controls = append(res.Controls, r.Controls()...)
	}
	// Cancellation is not reported by the response: say which of the two ended the wait.
	if err := sctx.Err(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ldap.NewError(ldap.ErrorNetwork, errors.New("ldap: connection timed out"))
	}
	if err := r.Err(); err != nil {
		return res, err
	}
	// A connection that dies mid-search ends the stream without an error of its own.
	if c.IsClosing() {
		return nil, ldap.NewError(ldap.ErrorNetwork, errors.New("ldap: connection closed"))
	}
	return res, nil
}
