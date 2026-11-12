package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/S0obi/kanopa/internal/ldapx"
)

// Search reads at most searchLimit entries, searchPage at a time.
const (
	searchLimit = 500
	searchPage  = 100
	// searchColumns bounds the extra attributes a search can add as columns.
	searchColumns = 12
	// cellLimit shortens a long value in a results cell; the entry view has the whole of it.
	cellLimit = 300
)

// SearchRequest is one search from the Search panel.
type SearchRequest struct {
	Base       string   `json:"base"`  // empty: the connection's base DN
	Scope      string   `json:"scope"` // base | one | sub
	Filter     string   `json:"filter"`
	Attributes []string `json:"attributes"` // columns to show besides name, type and DN
}

// SearchRow is one entry found.
type SearchRow struct {
	DN   string `json:"dn"`
	Name string `json:"name"`
	Type string `json:"type"` // root | ou | person | group | server | entry
	Sub  string `json:"sub"`  // its description
	// Cells holds the values of each requested attribute, in the order of SearchResult.Columns.
	Cells [][]string `json:"cells"`
}

// SearchResult is what a search found and how it ended.
type SearchResult struct {
	Rows    []SearchRow `json:"rows"`
	Columns []string    `json:"columns"`
	Base    string      `json:"base"`
	Scope   string      `json:"scope"`
	Filter  string      `json:"filter"` // as sent
	Limit   int         `json:"limit"`  // the most entries Kanopa reads for one search
	// Truncated: more entries match than were read. ServerLimit says the server's own size limit
	// stopped the search, rather than Kanopa's.
	Truncated   bool `json:"truncated"`
	ServerLimit bool `json:"serverLimit"`
	// Paged is false on a server without the paged results control.
	Paged     bool     `json:"paged"`
	ElapsedMs int64    `json:"elapsedMs"`
	Failure   *Failure `json:"failure"`
}

// FilterCheck is the verdict on a search filter, before anything is sent.
type FilterCheck struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	// Position is the 0-based character the message points at.
	Position   int    `json:"position"`
	Suggestion string `json:"suggestion"`
}

// CheckFilter says whether text is a valid LDAP filter and, when not, where it goes wrong.
func (d *DirectoryService) CheckFilter(text string) FilterCheck {
	if err := ldapx.CheckFilter(text); err != nil {
		return FilterCheck{Message: err.Msg, Position: err.Pos, Suggestion: err.Suggestion}
	}
	return FilterCheck{OK: true}
}

// AttributeNames lists the attribute names of the server's schema, sorted, to complete a filter and
// the columns. It is empty when the server would not share its schema.
func (d *DirectoryService) AttributeNames(id string) []string {
	l, f := d.session(id)
	if f != nil || l.schema == nil {
		return []string{}
	}
	return nonNil(l.schema.AttributeNames())
}

var scopes = map[string]int{"base": ldapx.ScopeBase, "one": ldapx.ScopeOneLevel, "sub": ldapx.ScopeSubtree}

// Search runs a search on an open connection and reads up to 500 entries, 100 per round trip. It
// holds the connection's paged-search lock while it reads, so the tree and the pickers wait their
// turn instead of colliding with it; canceling ctx stops it between pages.
func (d *DirectoryService) Search(ctx context.Context, id string, req SearchRequest) SearchResult {
	l, f := d.session(id)
	if f != nil {
		return SearchResult{Failure: f, Rows: []SearchRow{}, Columns: []string{}}
	}
	out := SearchResult{Rows: []SearchRow{}, Columns: []string{}, Limit: searchLimit, Paged: !l.NoPaging}
	refuse := func(title, msg string) SearchResult {
		out.Failure = &Failure{Title: title, Message: msg}
		return out
	}

	filter := strings.TrimSpace(req.Filter)
	if filter == "" {
		filter = "(objectClass=*)"
	}
	if err := ldapx.CheckFilter(filter); err != nil {
		msg := err.Msg
		if err.Suggestion != "" {
			msg += " Try " + err.Suggestion + "."
		}
		return refuse("The filter is not valid.", msg)
	}
	scope, ok := scopes[req.Scope]
	if !ok {
		return refuse("Search not sent.", fmt.Sprintf("Kanopa searches \"base\", \"one\" or \"sub\", not %q.", req.Scope))
	}
	base := strings.TrimSpace(req.Base)
	if base == "" {
		base = l.baseDN
	}
	out.Base, out.Scope, out.Filter = base, req.Scope, filter

	var columns []string
	for _, a := range req.Attributes {
		a = strings.TrimSpace(a)
		if a == "" || a == "*" || a == "+" || hasString(columns, a) {
			continue
		}
		columns = append(columns, a)
	}
	if len(columns) > searchColumns {
		return refuse("Search not sent.", fmt.Sprintf("A search shows at most %d attributes as columns.", searchColumns))
	}
	out.Columns = nonNil(columns)

	start := time.Now()
	l.paged.Lock()
	r, err := l.Search(ctx, ldapx.SearchParams{Base: base, Scope: scope, Filter: filter, Attrs: columns,
		PageSize: searchPage, Limit: searchLimit, Mode: l.referrals})
	l.paged.Unlock()
	out.ElapsedMs = time.Since(start).Milliseconds()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return refuse("Search stopped.", "The search was stopped before it finished.")
		}
		out.Failure = d.fail(l, err)
		return out
	}
	out.Truncated, out.ServerLimit = r.Cut != ldapx.NotCut, r.Cut == ldapx.CutByServer
	for _, e := range r.Entries {
		out.Rows = append(out.Rows, rowOf(e.DN, e.GetAttributeValues("objectClass"), e.GetAttributeValue("displayName"),
			e.GetAttributeValue("cn"), e.GetAttributeValue("uid"), e.GetAttributeValue("ou"), e.GetAttributeValue("description"),
			e.GetAttributeValues("ref"), columns, e.GetEqualFoldAttributeValues))
	}
	// Counts only: what was asked for stays out of the log.
	d.log.Info("search", "id", id, "rows", len(out.Rows), "truncated", out.Truncated, "elapsed_ms", out.ElapsedMs)
	return out
}

// rowOf describes one entry found: what to call it, what it is, and the values of the columns.
func rowOf(dn string, classes []string, displayName, cn, uid, ou, description string, refs, columns []string, values func(string) []string) SearchRow {
	row := SearchRow{DN: dn, Type: typeOf(classes, false), Sub: description, Cells: make([][]string, 0, len(columns))}
	rdn := firstRDN(dn)
	row.Name = rdn
	for _, n := range []string{displayName, cn, uid, ou} {
		if n != "" {
			row.Name = n
			break
		}
	}
	if hasClass(classes, "referral") {
		row.Type = "entry"
		if len(refs) > 0 {
			row.Sub = refs[0]
		}
	}
	for _, c := range columns {
		vals := values(c)
		cell := make([]string, 0, len(vals))
		for _, v := range vals {
			cell = append(cell, cellText(v))
		}
		row.Cells = append(row.Cells, cell)
	}
	return row
}

// cellText shows a value in a results cell: text as is (shortened when long), anything else by its size.
func cellText(v string) string {
	if !utf8.ValidString(v) {
		return fmt.Sprintf("(binary, %d bytes)", len(v))
	}
	if r := []rune(v); len(r) > cellLimit {
		return string(r[:cellLimit]) + "…"
	}
	return v
}
