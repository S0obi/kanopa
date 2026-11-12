package ldapx

import (
	"context"
	"strings"

	"github.com/go-ldap/ldap/v3"
)

// Search scopes Kanopa uses.
const (
	ScopeBase    = ldap.ScopeBaseObject
	ScopeSubtree = ldap.ScopeWholeSubtree
)

// SearchParams is one search the person asked for.
type SearchParams struct {
	Base   string
	Scope  int
	Filter string
	// Attrs are the attributes to return besides the ones Kanopa always reads to name and type an entry.
	Attrs    []string
	PageSize int
	Limit    int
	Mode     ReferralMode
}

// namingAttrs are read for every result, to name and type it.
var namingAttrs = []string{"objectClass", "cn", "uid", "ou", "description", "displayName", "ref"}

// Search runs the search and reads up to p.Limit entries. cut says whether and why it stopped
// early. The filter is sent as given: check it with CheckFilter first.
func (s *Session) Search(ctx context.Context, p SearchParams) (Read, error) {
	attrs := append([]string{}, namingAttrs...)
	for _, a := range p.Attrs {
		a = strings.TrimSpace(a)
		if a != "" && !containsFold(attrs, a) {
			attrs = append(attrs, a)
		}
	}
	req := ldap.NewSearchRequest(p.Base, p.Scope, ldap.NeverDerefAliases, 0, s.secs(), false, p.Filter, attrs, p.Mode.controls())
	r, err := s.readBounded(ctx, req, max(p.PageSize, 1), p.Limit)
	if err != nil {
		return Read{}, Classify(err, s.op())
	}
	return r, nil
}

func containsFold(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}
