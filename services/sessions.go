package services

import (
	"strings"
	"sync"

	"github.com/S0obi/kanopa/internal/ldapx"
)

// liveSession is an open connection and what Kanopa learned about the server when it opened.
type liveSession struct {
	*ldapx.Session
	id             string
	name           string
	baseDN         string
	namingContexts []string
	subschemaDN    string
	schema         *ldapx.Schema // nil when the server would not share it
	pageSize       int
	referrals      ldapx.ReferralMode
	readOnly       bool // Kanopa never sends changes over this connection
	assertion      bool // the server supports the assertion control (RFC 4528)
	passwordModify bool // the server supports the Password Modify operation (RFC 3062)

	// paged serializes paged searches: many servers keep one per connection, and a second
	// one started meanwhile invalidates the first one's cookie.
	paged sync.Mutex

	mu       sync.Mutex
	children map[string]*childList // the last full read of each parent, by lower-case DN
}

// childList is every child of one parent, read in one paged search.
type childList struct {
	nodes     []TreeNode
	truncated bool // the parent has more than childLimit children
}

func (l *liveSession) cachedChildren(dn string) *childList {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.children[strings.ToLower(dn)]
}

func (l *liveSession) cacheChildren(dn string, c *childList) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.children == nil {
		l.children = map[string]*childList{}
	}
	l.children[strings.ToLower(dn)] = c
}

// forgetChildren drops every cached child list, so the tree reads them again.
func (l *liveSession) forgetChildren() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.children = nil
}

// registry holds the open sessions, shared by ConnectionService and DirectoryService.
type registry struct {
	mu sync.Mutex
	m  map[string]*liveSession
}

func newRegistry() *registry { return &registry{m: map[string]*liveSession{}} }

func (r *registry) get(id string) *liveSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.m[id]
}

// put stores a session, closing the one it replaces.
func (r *registry) put(l *liveSession) {
	r.mu.Lock()
	old := r.m[l.id]
	r.m[l.id] = l
	r.mu.Unlock()
	if old != nil && old != l {
		old.Close()
	}
}

// drop closes and forgets a session; when only is not nil, only if it is still that one.
func (r *registry) drop(id string, only *liveSession) bool {
	r.mu.Lock()
	l := r.m[id]
	if l == nil || (only != nil && l != only) {
		r.mu.Unlock()
		return false
	}
	delete(r.m, id)
	r.mu.Unlock()
	l.Close()
	return true
}

func (r *registry) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.m)
}

func (r *registry) closeAll() {
	r.mu.Lock()
	all := r.m
	r.m = map[string]*liveSession{}
	r.mu.Unlock()
	for _, l := range all {
		l.Close()
	}
}

func hasString(list []string, v string) bool {
	for _, s := range list {
		if strings.EqualFold(strings.TrimSpace(s), v) {
			return true
		}
	}
	return false
}
