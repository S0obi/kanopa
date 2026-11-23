package ldapx

import (
	"context"
	"errors"
	"hash/fnv"
	"strings"

	"github.com/go-ldap/ldap/v3"
)

// StreamEnd says how a streamed read ended without an error: the server may have stopped it early,
// and may have answered with references to other servers, which are never followed.
type StreamEnd struct {
	// Cut is NotCut, or CutByServer when the server's own size limit ended the read.
	Cut Cut
	// Referrals are the continuation references the server returned instead of entries.
	Referrals []string
}

// Stream reads base (scope ScopeBase or ScopeSubtree) and hands every entry, with its user
// attributes, to fn as it arrives: a page at a time with the paged results control, so a big subtree
// is never held in memory. Referral objects come back as ordinary entries (ManageDsaIT).
//
// A server size limit ends the read with a nil error and Cut set; any other failure, including fn's
// own error, is returned after the entries before it were delivered. Canceling ctx stops waiting at
// once and abandons the paged search on the server.
func (s *Session) Stream(ctx context.Context, base string, scope, pageSize int, fn func(*ldap.Entry) error) (StreamEnd, error) {
	var end StreamEnd
	req := ldap.NewSearchRequest(base, scope, ldap.NeverDerefAliases, 0, s.secs(), false, "(objectClass=*)", []string{"*"}, ReferralsAsEntries.controls())
	deliver := func(res *ldap.SearchResult) error {
		for _, e := range res.Entries {
			if err := fn(e); err != nil {
				return err
			}
		}
		return nil
	}

	if s.NoPaging {
		res, err := keepSearch(ctx, s.Conn, req)
		return s.finish(&end, res, err, deliver)
	}

	base0 := req.Controls
	var cookie []byte
	for {
		paging := ldap.NewControlPaging(uint32(min(max(pageSize, 1), 1<<20))) //nolint:gosec // G115: clamped to 1..1,048,576
		paging.SetCookie(cookie)
		req.Controls = append(append([]ldap.Control{}, base0...), paging)
		res, err := keepSearch(ctx, s.Conn, req)
		if err != nil {
			if errors.Is(err, context.Canceled) && len(cookie) > 0 {
				s.abandon(req, base0, cookie)
			}
			return s.finish(&end, res, err, deliver)
		}
		end.Referrals = append(end.Referrals, res.Referrals...)
		if err := deliver(res); err != nil {
			s.abandonCookie(req, base0, res)
			return end, err
		}
		ctrl, ok := ldap.FindControl(res.Controls, ldap.ControlTypePaging).(*ldap.ControlPaging)
		if !ok || len(ctrl.Cookie) == 0 {
			return end, nil
		}
		cookie = ctrl.Cookie
	}
}

// finish delivers what a failed or size-limited search still returned, then reports how it ended.
func (s *Session) finish(end *StreamEnd, res *ldap.SearchResult, err error, deliver func(*ldap.SearchResult) error) (StreamEnd, error) {
	if res != nil {
		end.Referrals = append(end.Referrals, res.Referrals...)
		if derr := deliver(res); derr != nil {
			return *end, derr
		}
	}
	switch {
	case err == nil:
		return *end, nil
	case sizeLimited(err) && res != nil:
		end.Cut = CutByServer
		return *end, nil
	case errors.Is(err, context.Canceled):
		return *end, err
	}
	return *end, Classify(err, s.op())
}

// abandon tells the server to drop the paged search behind cookie, so the connection is ready for the next one.
func (s *Session) abandon(req *ldap.SearchRequest, base []ldap.Control, cookie []byte) {
	stop := ldap.NewControlPaging(0)
	stop.SetCookie(cookie)
	req.Controls = append(append([]ldap.Control{}, base...), stop)
	_, _ = s.Conn.Search(req)
}

func (s *Session) abandonCookie(req *ldap.SearchRequest, base []ldap.Control, res *ldap.SearchResult) {
	if ctrl, ok := ldap.FindControl(res.Controls, ldap.ControlTypePaging).(*ldap.ControlPaging); ok && len(ctrl.Cookie) > 0 {
		s.abandon(req, base, ctrl.Cookie)
	}
}

// ParentDN cuts the first RDN off a DN as written, keeping the parent's spelling; "" for a top entry.
func ParentDN(dn string) string { return parentOf(dn) }

// DNKey is a number that is the same for two spellings of one DN (case, spaces after commas). It
// is for remembering which DNs were seen without holding them all.
func DNKey(dn string) uint64 {
	h := fnv.New64a()
	d, err := ldap.ParseDN(dn)
	if err != nil {
		_, _ = h.Write([]byte(strings.ToLower(strings.TrimSpace(dn))))
		return h.Sum64()
	}
	for _, rdn := range d.RDNs {
		for _, a := range rdn.Attributes {
			_, _ = h.Write([]byte(strings.ToLower(a.Type) + "=" + strings.ToLower(a.Value) + "+"))
		}
		_, _ = h.Write([]byte{','})
	}
	return h.Sum64()
}
