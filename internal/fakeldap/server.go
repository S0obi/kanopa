// Package fakeldap is a small LDAP server that runs inside a test. Its features switch off, so
// Kanopa can be tried against a directory that doesn't page, doesn't say how many children an
// entry has, or stops a search at a size limit: things the OpenLDAP fixture never does.
//
// It speaks just enough LDAP for reading: anonymous or simple bind (any password is accepted),
// the root DSE, and searches with a filter, scope, size limit and the paged results control.
// It never writes, and it is not a model of any real server.
package fakeldap

import (
	"context"
	"fmt"
	"net"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
)

// Entry is one entry of the fake directory.
type Entry struct {
	DN    string
	Attrs map[string][]string
}

// Options switch the server's features. The zero value is a bare server: no paging, no child
// counts, no size limit.
type Options struct {
	// Paging offers and honors the paged results control (RFC 2696).
	Paging bool
	// HasSubordinates and NumSubordinates make the operational attributes of the same name available.
	HasSubordinates bool
	NumSubordinates bool
	// SizeLimit is the most entries the server returns for one search (or one page); 0 means no limit.
	// A search that has more matches returns that many and ends with Size limit exceeded (4).
	SizeLimit int
	// HideControls leaves supportedControl out of the root DSE, as servers that don't publish it do.
	HideControls bool
}

// Request is a search the server received.
type Request struct {
	Base      string
	Scope     int
	SizeLimit int
	Filter    string
	Attrs     []string
	Paged     bool // the request carried the paged results control
}

// Server is a running fake directory.
type Server struct {
	opts    Options
	entries []Entry
	ln      net.Listener
	wg      sync.WaitGroup

	mu       sync.Mutex
	requests []Request
}

// Start runs a server over entries on a free local port until the test ends.
func Start(t testing.TB, entries []Entry, opts Options) *Server {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{opts: opts, entries: slices.Clone(entries), ln: ln}
	s.wg.Add(1)
	go s.serve()
	t.Cleanup(func() {
		_ = ln.Close()
		s.wg.Wait()
	})
	return s
}

// URL is the address to connect to: ldap://127.0.0.1:port.
func (s *Server) URL() string { return "ldap://" + s.ln.Addr().String() }

// Requests returns the searches received so far.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.requests)
}

func (s *Server) serve() {
	defer s.wg.Done()
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer c.Close()
			s.handle(c)
		}()
	}
}

const (
	oidPaging = "1.2.840.113556.1.4.319"

	appBind    = 0
	appUnbind  = 2
	appSearch  = 3
	appAbandon = 16
)

func (s *Server) handle(c net.Conn) {
	for {
		p, err := ber.ReadPacket(c)
		if err != nil {
			return
		}
		if len(p.Children) < 2 {
			return
		}
		id, _ := p.Children[0].Value.(int64)
		op := p.Children[1]
		switch op.Tag {
		case appBind:
			s.send(c, id, result(1, 0, ""))
		case appSearch:
			if !s.search(c, id, op, controlsOf(p)) {
				return
			}
		case appUnbind:
			return
		case appAbandon:
		default:
			// Writes and anything else: refuse, with the response tag that matches the request.
			s.send(c, id, result(op.Tag+1, 53, "this fake server only reads"))
		}
	}
}

// controlsOf returns the request's controls: OID to raw value.
func controlsOf(p *ber.Packet) map[string][]byte {
	out := map[string][]byte{}
	if len(p.Children) < 3 {
		return out
	}
	for _, ctrl := range p.Children[2].Children {
		if len(ctrl.Children) == 0 {
			continue
		}
		oid, _ := ctrl.Children[0].Value.(string)
		var val []byte
		if last := ctrl.Children[len(ctrl.Children)-1]; len(ctrl.Children) > 1 && last.Tag == ber.TagOctetString {
			if str, ok := last.Value.(string); ok {
				val = []byte(str)
			}
		}
		out[oid] = val
	}
	return out
}

// result is an LDAPResult-shaped response with the given application tag.
func result(tag ber.Tag, code int, diag string) *ber.Packet {
	p := ber.Encode(ber.ClassApplication, ber.TypeConstructed, tag, nil, "Result")
	p.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, int64(code), "Code"))
	p.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "Matched"))
	p.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, diag, "Diagnostic"))
	return p
}

func (s *Server) send(c net.Conn, id int64, op *ber.Packet, controls ...*ber.Packet) {
	msg := ber.NewSequence("LDAPMessage")
	msg.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "MessageID"))
	msg.AppendChild(op)
	if len(controls) > 0 {
		set := ber.Encode(ber.ClassContext, ber.TypeConstructed, 0, nil, "Controls")
		for _, ctrl := range controls {
			set.AppendChild(ctrl)
		}
		msg.AppendChild(set)
	}
	_, _ = c.Write(msg.Bytes())
}

// search answers one search request; false means the connection is no longer usable.
func (s *Server) search(c net.Conn, id int64, op *ber.Packet, ctrls map[string][]byte) bool {
	if len(op.Children) < 8 {
		return false
	}
	base := normDN(op.Children[0].Value.(string))
	scope := int(op.Children[1].Value.(int64))
	sizeLimit := int(op.Children[3].Value.(int64))
	typesOnly, _ := op.Children[5].Value.(bool)
	filter := op.Children[6]
	var attrs []string
	for _, a := range op.Children[7].Children {
		attrs = append(attrs, a.Value.(string))
	}

	pageSize, cookie, paged := 0, "", false
	if raw, ok := ctrls[oidPaging]; ok {
		paged = true
		if v, err := ber.DecodePacketErr(raw); err == nil && len(v.Children) == 2 {
			pageSize = int(v.Children[0].Value.(int64))
			cookie = v.Children[1].Data.String()
		}
	}
	f, _ := ldap.DecompileFilter(filter)
	s.mu.Lock()
	s.requests = append(s.requests, Request{Base: base, Scope: scope, SizeLimit: sizeLimit, Filter: f, Attrs: attrs, Paged: paged})
	s.mu.Unlock()

	// The root DSE.
	if base == "" && scope == 0 {
		s.send(c, id, entryPacket("", s.rootDSE(), attrs, typesOnly))
		s.send(c, id, result(5, 0, ""))
		return true
	}
	if !s.exists(base) {
		s.send(c, id, result(5, 32, "no such object"))
		return true
	}

	var matches []Entry
	for _, e := range s.entries {
		if inScope(normDN(e.DN), base, scope) && matchFilter(filter, e) {
			matches = append(matches, e)
		}
	}

	var out []Entry
	nextCookie := ""
	pagedReply := paged && s.opts.Paging
	switch {
	case pagedReply && pageSize == 0:
		// An abandoned paged search: nothing to return.
	case pagedReply:
		from, _ := strconv.Atoi(cookie)
		from = min(max(from, 0), len(matches))
		to := min(from+pageSize, len(matches))
		out = matches[from:to]
		if to < len(matches) {
			nextCookie = strconv.Itoa(to)
		}
	default:
		out = matches
	}

	limit := s.opts.SizeLimit
	if sizeLimit > 0 && (limit == 0 || sizeLimit < limit) {
		limit = sizeLimit
	}
	code := 0
	if limit > 0 && len(out) > limit {
		out, code, nextCookie = out[:limit], 4, ""
	}
	for _, e := range out {
		s.send(c, id, entryPacket(e.DN, s.project(e), attrs, typesOnly))
	}
	var done []*ber.Packet
	if pagedReply {
		done = append(done, pagingControl(nextCookie))
	}
	s.send(c, id, result(5, code, ""), done...)
	return true
}

func pagingControl(cookie string) *ber.Packet {
	ctrl := ber.NewSequence("Control")
	ctrl.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, oidPaging, "Type"))
	v := ber.NewSequence("Value")
	v.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, 0, "Size"))
	v.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, cookie, "Cookie"))
	ctrl.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, string(v.Bytes()), "Value"))
	return ctrl
}

func (s *Server) rootDSE() Entry {
	attrs := map[string][]string{
		"objectClass":    {"top"},
		"namingContexts": {},
		"vendorName":     {"Kanopa fake LDAP"},
	}
	for _, e := range s.entries {
		if !s.exists(parentOf(normDN(e.DN))) {
			attrs["namingContexts"] = append(attrs["namingContexts"], e.DN)
		}
	}
	if !s.opts.HideControls {
		controls := []string{"1.3.6.1.4.1.4203.666.5.12"} // something harmless, so the list isn't empty
		if s.opts.Paging {
			controls = append(controls, oidPaging)
		}
		attrs["supportedControl"] = controls
	}
	return Entry{Attrs: attrs}
}

// project adds the operational attributes this server offers; entryPacket picks what was asked for.
func (s *Server) project(e Entry) Entry {
	attrs := map[string][]string{}
	for k, v := range e.Attrs {
		attrs[k] = v
	}
	n := 0
	dn := normDN(e.DN)
	for _, o := range s.entries {
		if parentOf(normDN(o.DN)) == dn {
			n++
		}
	}
	if s.opts.HasSubordinates {
		attrs["hasSubordinates"] = []string{strings.ToUpper(strconv.FormatBool(n > 0))}
	}
	if s.opts.NumSubordinates {
		attrs["numSubordinates"] = []string{strconv.Itoa(n)}
	}
	return Entry{DN: e.DN, Attrs: attrs}
}

func (s *Server) exists(dn string) bool {
	return slices.ContainsFunc(s.entries, func(e Entry) bool { return normDN(e.DN) == dn })
}

var operational = map[string]bool{"hassubordinates": true, "numsubordinates": true, "namingcontexts": true, "supportedcontrol": true, "vendorname": true}

// entryPacket encodes a SearchResultEntry with the attributes that were asked for: none or "*"
// is every user attribute, "+" the operational ones, and a name picks that attribute.
func entryPacket(dn string, e Entry, want []string, typesOnly bool) *ber.Packet {
	p := ber.Encode(ber.ClassApplication, ber.TypeConstructed, 4, nil, "Entry")
	p.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, dn, "DN"))
	list := ber.NewSequence("Attributes")
	names := make([]string, 0, len(e.Attrs))
	for name := range e.Attrs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		lower := strings.ToLower(name)
		picked := false
		if len(want) == 0 {
			picked = !operational[lower]
		}
		for _, w := range want {
			switch {
			case w == "*":
				picked = picked || !operational[lower]
			case w == "+":
				picked = picked || operational[lower]
			case strings.EqualFold(w, name):
				picked = true
			}
		}
		if !picked {
			continue
		}
		attr := ber.NewSequence("Attribute")
		attr.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, name, "Type"))
		vals := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSet, nil, "Values")
		if !typesOnly {
			for _, v := range e.Attrs[name] {
				vals.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, v, "Value"))
			}
		}
		attr.AppendChild(vals)
		list.AppendChild(attr)
	}
	p.AppendChild(list)
	return p
}

// normDN lower-cases a DN and drops the spaces after its commas, to compare DNs.
func normDN(dn string) string {
	parts := strings.Split(dn, ",")
	for i := range parts {
		parts[i] = strings.ToLower(strings.TrimSpace(parts[i]))
	}
	return strings.Join(parts, ",")
}

func parentOf(dn string) string {
	if i := strings.Index(dn, ","); i >= 0 {
		return dn[i+1:]
	}
	return ""
}

func inScope(dn, base string, scope int) bool {
	switch scope {
	case 0:
		return dn == base
	case 1:
		return parentOf(dn) == base
	}
	return dn == base || strings.HasSuffix(dn, ","+base)
}

func values(e Entry, attr string) []string {
	for k, v := range e.Attrs {
		if strings.EqualFold(k, attr) {
			return v
		}
	}
	return nil
}

// matchFilter evaluates a BER-encoded search filter against an entry: and, or, not, equality,
// substrings, ordering, presence. Anything else (extensible match) matches nothing.
func matchFilter(f *ber.Packet, e Entry) bool {
	if f.ClassType != ber.ClassContext {
		return false
	}
	switch f.Tag {
	case 0:
		for _, c := range f.Children {
			if !matchFilter(c, e) {
				return false
			}
		}
		return true
	case 1:
		for _, c := range f.Children {
			if matchFilter(c, e) {
				return true
			}
		}
		return false
	case 2:
		return len(f.Children) == 1 && !matchFilter(f.Children[0], e)
	case 3, 5, 6, 8:
		if len(f.Children) != 2 {
			return false
		}
		want := strings.ToLower(f.Children[1].Value.(string))
		for _, v := range values(e, f.Children[0].Value.(string)) {
			have := strings.ToLower(v)
			switch f.Tag {
			case 3, 8:
				if have == want {
					return true
				}
			case 5:
				if have >= want {
					return true
				}
			case 6:
				if have <= want {
					return true
				}
			}
		}
		return false
	case 4:
		return matchSubstrings(f, e)
	case 7:
		attr := f.Data.String()
		return strings.EqualFold(attr, "objectClass") || len(values(e, attr)) > 0
	}
	return false
}

func matchSubstrings(f *ber.Packet, e Entry) bool {
	if len(f.Children) != 2 {
		return false
	}
	for _, v := range values(e, f.Children[0].Value.(string)) {
		rest := strings.ToLower(v)
		ok := true
		for _, piece := range f.Children[1].Children {
			sub := strings.ToLower(piece.Data.String())
			switch piece.Tag {
			case 0: // initial
				if !strings.HasPrefix(rest, sub) {
					ok = false
				} else {
					rest = rest[len(sub):]
				}
			case 1: // any
				i := strings.Index(rest, sub)
				if i < 0 {
					ok = false
				} else {
					rest = rest[i+len(sub):]
				}
			case 2: // final
				if !strings.HasSuffix(rest, sub) {
					ok = false
				}
			}
			if !ok {
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// People builds n entries "uid=userNNNN,ou=people,<base>" for tests that need many.
func People(base string, n int) []Entry {
	out := make([]Entry, 0, n)
	for i := 1; i <= n; i++ {
		uid := fmt.Sprintf("user%04d", i)
		out = append(out, Entry{DN: "uid=" + uid + ",ou=people," + base, Attrs: map[string][]string{
			"objectClass": {"inetOrgPerson", "organizationalPerson", "person", "top"},
			"uid":         {uid}, "cn": {"User " + uid}, "sn": {uid}, "mail": {uid + "@example.org"},
		}})
	}
	return out
}
