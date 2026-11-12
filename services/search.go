package services

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"

	"github.com/S0obi/kanopa/internal/ldapx"
)

// Quick find reads up to quickRead matches to rank and count them, and shows quickShow.
const (
	quickRead     = 200
	quickShow     = 10
	quickMinChars = 2
	// quickWords bounds how many words of a plain search are used.
	quickWords = 6
)

// Modes of a quick find.
const (
	ModeNames  = "names"  // a plain word or words, matched against names and mail
	ModeFilter = "filter" // an LDAP filter
)

// QuickHit is one entry a quick find lists.
type QuickHit struct {
	DN   string `json:"dn"`
	Name string `json:"name"`
	Type string `json:"type"` // root | ou | person | group | server | entry
	Sub  string `json:"sub"`  // a person's mail, else the entry's description
}

// FilterCheck says what is wrong with a search filter, and where.
type FilterCheck struct {
	Message string `json:"message"`
	// Position is the 0-based character of the typed text the message points at.
	Position int `json:"position"`
}

// QuickResult is what a quick find found and how it ended.
type QuickResult struct {
	Mode   string `json:"mode"`
	Filter string `json:"filter"` // as sent to the server
	// Hits are the best quickShow matches, best first (names) or in the server's order (filter).
	Hits []QuickHit `json:"hits"`
	// Total is how many matches were read, at most quickRead; More says there are others.
	Total int  `json:"total"`
	More  bool `json:"more"`
	// ServerLimit: the server's own size limit ended the search, not Kanopa's.
	ServerLimit bool `json:"serverLimit"`
	// Paged is false on a server without the paged results control.
	Paged     bool  `json:"paged"`
	ElapsedMs int64 `json:"elapsedMs"`
	// Invalid is set for an LDAP filter that can't be sent; nothing reached the server.
	Invalid *FilterCheck `json:"invalid"`
	Failure *Failure     `json:"failure"`
}

// assertion matches text that is an LDAP "attribute=value" without its parentheses.
var assertion = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._;-]*[~<>]?=`)

// Attributes a plain word is matched against. Names and mail start with the word; the others
// may contain it.
var (
	prefixAttrs    = []string{"uid", "mail", "givenName"}
	substringAttrs = []string{"cn", "sn", "displayName", "ou"}
)

// quickFilter decides what a quick find searches for. Text that starts with "(" is an LDAP filter,
// and so is "attribute=value" (it gets its parentheses). Anything else is words, each of which
// must match a name or a mail address.
func quickFilter(text string) (mode, filter string, words []string) {
	text = strings.TrimSpace(text)
	switch {
	case strings.HasPrefix(text, "("):
		return ModeFilter, text, nil
	case assertion.MatchString(text):
		return ModeFilter, "(" + text + ")", nil
	}
	words = strings.Fields(text)
	if len(words) > quickWords {
		words = words[:quickWords]
	}
	var all strings.Builder
	for _, w := range words {
		e := ldapx.EscapeFilter(w)
		all.WriteString("(|")
		for _, a := range prefixAttrs {
			all.WriteString("(" + a + "=" + e + "*)")
		}
		for _, a := range substringAttrs {
			all.WriteString("(" + a + "=*" + e + "*)")
		}
		all.WriteString(")")
	}
	if len(words) == 1 {
		return ModeNames, all.String(), words
	}
	return ModeNames, "(&" + all.String() + ")", words
}

// Quick finds entries under the connection's base DN for the header search field. Plain words
// match names and mail case-insensitively and come back best match first; an LDAP filter comes
// back in the server's order. It reads up to 200 matches in one round trip and holds the
// connection's paged-search lock meanwhile, so the tree waits its turn; canceling ctx stops it.
func (d *DirectoryService) Quick(ctx context.Context, id, text string) QuickResult {
	l, f := d.session(id)
	if f != nil {
		return QuickResult{Failure: f, Hits: []QuickHit{}}
	}
	mode, filter, words := quickFilter(text)
	out := QuickResult{Mode: mode, Filter: filter, Hits: []QuickHit{}, Paged: !l.NoPaging}
	if mode == ModeNames && len([]rune(strings.TrimSpace(text))) < quickMinChars {
		return out
	}
	if mode == ModeFilter {
		if err := ldapx.CheckFilter(filter); err != nil {
			bare := !strings.HasPrefix(strings.TrimSpace(text), "(")
			pos := err.Pos
			if bare && pos > 0 {
				pos-- // the parenthesis Kanopa added is not in the text
			}
			out.Invalid = &FilterCheck{Message: err.Msg, Position: pos}
			return out
		}
	}
	if l.baseDN == "" {
		out.Failure = &Failure{Title: "No base DN.", Message: "This connection has no base DN to search from. Edit the connection and set one."}
		return out
	}

	start := time.Now()
	l.paged.Lock()
	r, err := l.Search(ctx, ldapx.SearchParams{Base: l.baseDN, Scope: ldapx.ScopeSubtree, Filter: filter,
		Attrs: []string{"mail", "sn", "givenName"}, PageSize: quickRead, Limit: quickRead, Mode: l.referrals})
	l.paged.Unlock()
	out.ElapsedMs = time.Since(start).Milliseconds()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			out.Failure = &Failure{Title: "Search stopped.", Message: "The search was stopped before it finished."}
			return out
		}
		out.Failure = d.fail(l, err)
		return out
	}
	out.Total, out.More, out.ServerLimit = len(r.Entries), r.Cut != ldapx.NotCut, r.Cut == ldapx.CutByServer

	entries := r.Entries
	if mode == ModeNames {
		entries = ranked(entries, words)
	}
	for _, e := range entries[:min(quickShow, len(entries))] {
		out.Hits = append(out.Hits, hitOf(e))
	}
	// Counts only: what was typed stays out of the log.
	d.log.Info("quick find", "id", id, "mode", mode, "matches", out.Total, "elapsed_ms", out.ElapsedMs)
	return out
}

// nameOf is what an entry is called: its display name, cn, uid, ou, else its first RDN.
func nameOf(e *ldap.Entry) string {
	for _, a := range []string{"displayName", "cn", "uid", "ou"} {
		if v := e.GetAttributeValue(a); v != "" {
			return v
		}
	}
	return firstRDN(e.DN)
}

func hitOf(e *ldap.Entry) QuickHit {
	classes := e.GetAttributeValues("objectClass")
	h := QuickHit{DN: e.DN, Name: nameOf(e), Type: typeOf(classes, false), Sub: e.GetAttributeValue("description")}
	if mail := e.GetAttributeValue("mail"); mail != "" && h.Type == "person" {
		h.Sub = mail
	}
	if hasClass(classes, "referral") {
		h.Type = "entry"
		if refs := e.GetAttributeValues("ref"); len(refs) > 0 {
			h.Sub = refs[0]
		}
	}
	return h
}

// ranked orders entries by how well they match the words: an entry whose name or mail is exactly
// a word comes first, then one that starts with it, then one that contains it. Within a rank, by name.
func ranked(entries []*ldap.Entry, words []string) []*ldap.Entry {
	type scored struct {
		e    *ldap.Entry
		tier int
		name string
	}
	list := make([]scored, len(entries))
	for i, e := range entries {
		list[i] = scored{e, tierOf(e, words), strings.ToLower(nameOf(e))}
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].tier != list[j].tier {
			return list[i].tier < list[j].tier
		}
		return list[i].name < list[j].name
	})
	out := make([]*ldap.Entry, len(list))
	for i, s := range list {
		out[i] = s.e
	}
	return out
}

// tierOf is the worst of the words' best matches: 0 exact, 1 prefix, 2 contained, 3 matched some other way.
func tierOf(e *ldap.Entry, words []string) int {
	worst := 0
	for _, w := range words {
		w = strings.ToLower(w)
		best := 3
		for _, a := range append(append([]string{}, prefixAttrs...), substringAttrs...) {
			for _, v := range e.GetAttributeValues(a) {
				v = strings.ToLower(v)
				switch {
				case v == w:
					best = min(best, 0)
				case strings.HasPrefix(v, w):
					best = min(best, 1)
				case strings.Contains(v, w):
					best = min(best, 2)
				}
			}
		}
		worst = max(worst, best)
	}
	return worst
}
