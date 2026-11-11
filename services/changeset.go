package services

import (
	"fmt"
	"sort"
	"strings"

	"github.com/S0obi/kanopa/internal/ldapx"
)

// Operations a change can carry.
const (
	opModify = "modify"
	opAdd    = "add"
	opDelete = "delete"
	opRename = "rename"
)

// step is one change in the order Kanopa sends it, with DNs as they are once the earlier steps
// have run: a pending rename moves the DNs (and DN values) that point at the renamed entry.
type step struct {
	index  int    // position in the change set the UI sent
	op     string // modify | add | delete | rename
	dn     string // the entry the step applies to
	newRDN string // rename: the escaped new RDN
	newDN  string // rename: the DN after it
	ch     EntryChange
}

// opOf is the operation of a change; an empty one is a modify.
func opOf(ch EntryChange) string {
	if ch.Op == "" {
		return opModify
	}
	return ch.Op
}

// orderChanges puts a change set in the order the server can take it:
//
//   - renames first, so later steps can use the new DNs
//   - adds, parents before children
//   - modifies, in the order given
//   - deletes, children before parents
//
// DNs and DN values that point at a renamed entry are rewritten to its new DN. Before values
// (and values to remove) are left as read: they describe what the server holds now.
func orderChanges(changes []EntryChange) ([]step, error) {
	type move struct{ from, to string }
	var moves []move
	deleted := map[int]bool{}
	steps := make([]step, 0, len(changes))
	for i, ch := range changes {
		s := step{index: i, op: opOf(ch), dn: ch.DN, ch: ch}
		switch s.op {
		case opModify, opAdd:
		case opDelete:
			deleted[i] = true
		case opRename:
			attr, _, parent, err := ldapx.SplitDN(ch.DN)
			if err != nil {
				return nil, err
			}
			if parent == "" {
				return nil, fmt.Errorf("%s is a naming context; Kanopa can't rename it", ch.DN)
			}
			if strings.TrimSpace(ch.NewRDN) == "" {
				return nil, fmt.Errorf("enter a new name for %s", ch.DN)
			}
			s.newRDN = ldapx.RDN(attr, ch.NewRDN)
			s.newDN = s.newRDN + "," + parent
			moves = append(moves, move{from: ch.DN, to: s.newDN})
		default:
			return nil, fmt.Errorf("%q is not a change Kanopa knows", ch.Op)
		}
		steps = append(steps, s)
	}
	// An entry marked for deletion takes no other change.
	for i, a := range steps {
		for j, b := range steps {
			if i != j && deleted[a.index] && !deleted[b.index] && b.op != opModify && ldapx.SameDN(a.dn, b.dn) {
				return nil, fmt.Errorf("%s is marked for deletion; undo the delete to %s it", firstRDN(a.dn), b.op)
			}
		}
	}

	rewrite := func(dn string) string {
		for _, m := range moves {
			if ldapx.SameDN(dn, m.from) {
				return m.to
			}
			if ldapx.UnderDN(dn, m.from) {
				return withParent(dn, m.from, m.to)
			}
		}
		return dn
	}
	for i := range steps {
		s := &steps[i]
		if s.op == opRename {
			continue
		}
		s.dn = rewrite(s.dn)
		s.ch.DN = s.dn
		attrs := make([]AttributeChange, len(s.ch.Attributes))
		for j, a := range s.ch.Attributes {
			if a.Kind == "dn" {
				a.After = mapValues(a.After, rewrite)
				a.Add = mapValues(a.Add, rewrite)
			}
			attrs[j] = a
		}
		s.ch.Attributes = attrs
	}

	rank := map[string]int{opRename: 0, opAdd: 1, opModify: 2, opDelete: 3}
	sort.SliceStable(steps, func(i, j int) bool {
		a, b := steps[i], steps[j]
		if rank[a.op] != rank[b.op] {
			return rank[a.op] < rank[b.op]
		}
		switch a.op {
		case opAdd:
			return depth(a.dn) < depth(b.dn)
		case opDelete:
			return depth(a.dn) > depth(b.dn)
		}
		return false
	})
	return steps, nil
}

func mapValues(vals []string, f func(string) string) []string {
	if vals == nil {
		return nil
	}
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = f(v)
	}
	return out
}

// rdns splits a DN into its RDNs as written, respecting escapes.
func rdns(dn string) []string {
	var out []string
	start := 0
	for i := 0; i < len(dn); i++ {
		switch dn[i] {
		case '\\':
			i++
		case ',':
			out = append(out, strings.TrimSpace(dn[start:i]))
			start = i + 1
		}
	}
	if s := strings.TrimSpace(dn[start:]); s != "" || len(out) > 0 {
		out = append(out, s)
	}
	return out
}

func depth(dn string) int { return len(rdns(dn)) }

// withParent moves dn, which lies below from, below to instead.
func withParent(dn, from, to string) string {
	parts := rdns(dn)
	keep := len(parts) - depth(from)
	if keep <= 0 {
		return dn
	}
	return strings.Join(parts[:keep], ",") + "," + to
}
