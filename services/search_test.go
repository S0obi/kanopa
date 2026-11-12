package services

import (
	"context"
	"testing"

	"github.com/S0obi/kanopa/internal/fakeldap"
)

const fakeBase = "dc=example,dc=org"
const fakePeople = "ou=people," + fakeBase

func fakeDirectory(n int) []fakeldap.Entry {
	top := []fakeldap.Entry{
		{DN: fakeBase, Attrs: map[string][]string{"objectClass": {"dcObject", "organization", "top"}, "dc": {"example"}}},
		{DN: fakePeople, Attrs: map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"people"}, "description": {"People"}}},
		{DN: "ou=groups," + fakeBase, Attrs: map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"groups"}}},
		{DN: "cn=admins,ou=groups," + fakeBase, Attrs: map[string][]string{"objectClass": {"groupOfNames", "top"}, "cn": {"admins"}, "member": {"uid=user0001," + fakePeople}}},
	}
	return append(top, fakeldap.People(fakeBase, n)...)
}

// connectFake opens a saved connection to the fake server, like the Connect screen does.
func connectFake(t *testing.T, srv *fakeldap.Server) (*DirectoryService, string, *SessionInfo) {
	t.Helper()
	s := newTestService(t)
	c, err := s.Save(SaveRequest{Name: "Fake", URL: srv.URL(), Security: "none", Bind: "anonymous", TimeoutSeconds: 5, PageSize: 500, Referrals: "show"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AllowUnencrypted(c.ID); err != nil {
		t.Fatal(err)
	}
	res := s.Connect(context.Background(), c.ID, "", false)
	if !res.OK {
		t.Fatalf("connect: %+v", res)
	}
	return NewDirectoryService(nil, s), c.ID, res.Session
}

func TestSearchReadsFiveHundredAtMostAndSaysSo(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{Paging: true})
	d, id, info := connectFake(t, srv)
	if !info.Paging {
		t.Fatal("the server offers paging")
	}
	r := d.Search(context.Background(), id, SearchRequest{Scope: "sub", Filter: "(objectClass=inetOrgPerson)"})
	if r.Failure != nil {
		t.Fatalf("failure %+v", r.Failure)
	}
	if len(r.Rows) != 500 || !r.Truncated || r.ServerLimit || !r.Paged || r.Limit != 500 {
		t.Fatalf("rows %d truncated %v serverLimit %v paged %v", len(r.Rows), r.Truncated, r.ServerLimit, r.Paged)
	}
	if r.Base != fakeBase || r.Filter != "(objectClass=inetOrgPerson)" {
		t.Fatalf("base %q filter %q", r.Base, r.Filter)
	}
	first := r.Rows[0]
	if first.Type != "person" || first.Name != "User user0001" || first.DN != "uid=user0001,"+fakePeople {
		t.Fatalf("first row %+v", first)
	}
	var pages int
	for _, q := range srv.Requests() {
		if q.Paged && q.Filter == "(objectClass=inetOrgPerson)" {
			pages++
		}
	}
	// Five pages of 100, then the cursor is closed.
	if pages != 6 {
		t.Fatalf("%d paged requests, want 5 pages and 1 to close the cursor", pages)
	}
}

func TestSearchOnAServerWithoutPaging(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{})
	d, id, info := connectFake(t, srv)
	if info.Paging {
		t.Fatal("the server lists its controls without paging")
	}
	r := d.Search(context.Background(), id, SearchRequest{Scope: "sub", Filter: "(uid=user*)"})
	if r.Failure != nil || len(r.Rows) != 500 || !r.Truncated || r.ServerLimit || r.Paged {
		t.Fatalf("rows %d truncated %v serverLimit %v paged %v failure %+v", len(r.Rows), r.Truncated, r.ServerLimit, r.Paged, r.Failure)
	}
	last := srv.Requests()[len(srv.Requests())-1]
	if last.Paged || last.SizeLimit != 501 {
		t.Fatalf("one plain search asking for one more than the limit, got %+v", last)
	}
}

func TestSearchKeepsWhatAServerSizeLimitReturned(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{SizeLimit: 200})
	d, id, _ := connectFake(t, srv)
	r := d.Search(context.Background(), id, SearchRequest{Scope: "sub", Filter: "(uid=user*)"})
	if r.Failure != nil {
		t.Fatalf("a size limit is not a failure: %+v", r.Failure)
	}
	if len(r.Rows) != 200 || !r.Truncated || !r.ServerLimit {
		t.Fatalf("rows %d truncated %v serverLimit %v", len(r.Rows), r.Truncated, r.ServerLimit)
	}
}

func TestSearchScopesColumnsAndNames(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(20), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	ctx := context.Background()

	one := d.Search(ctx, id, SearchRequest{Base: fakeBase, Scope: "one", Filter: "(objectClass=organizationalUnit)"})
	if len(one.Rows) != 2 || one.Rows[0].Type != "ou" || one.Rows[0].Name != "people" || one.Rows[0].Sub != "People" {
		t.Fatalf("one level: %+v", one.Rows)
	}
	base := d.Search(ctx, id, SearchRequest{Base: "uid=user0007," + fakePeople, Scope: "base", Filter: "(objectClass=*)"})
	if len(base.Rows) != 1 {
		t.Fatalf("base: %+v", base.Rows)
	}
	cols := d.Search(ctx, id, SearchRequest{Base: fakePeople, Scope: "sub", Filter: "(uid=user0007)", Attributes: []string{"mail", " sn ", "mail", "", "*", "title"}})
	if len(cols.Rows) != 1 || len(cols.Columns) != 3 || cols.Columns[0] != "mail" || cols.Columns[1] != "sn" {
		t.Fatalf("columns %v rows %+v", cols.Columns, cols.Rows)
	}
	row := cols.Rows[0]
	if len(row.Cells) != 3 || row.Cells[0][0] != "user0007@example.org" || row.Cells[1][0] != "user0007" || len(row.Cells[2]) != 0 {
		t.Fatalf("cells %v", row.Cells)
	}
	// An empty filter is everything.
	all := d.Search(ctx, id, SearchRequest{Base: fakePeople, Scope: "one", Filter: "  "})
	if all.Filter != "(objectClass=*)" || len(all.Rows) != 20 {
		t.Fatalf("empty filter: %q, %d rows", all.Filter, len(all.Rows))
	}
}

func TestSearchRefusesWhatCannotBeSentWithoutSendingIt(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(5), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	before := len(srv.Requests())
	ctx := context.Background()

	bad := d.Search(ctx, id, SearchRequest{Scope: "sub", Filter: "(&(uid=ada)"})
	if bad.Failure == nil || bad.Failure.Title != "The filter is not valid." {
		t.Fatalf("got %+v", bad.Failure)
	}
	bare := d.Search(ctx, id, SearchRequest{Scope: "sub", Filter: "uid=ada"})
	if bare.Failure == nil || bare.Failure.Message != "A filter is wrapped in parentheses, like (uid=ada). Try (uid=ada)." {
		t.Fatalf("got %+v", bare.Failure)
	}
	if r := d.Search(ctx, id, SearchRequest{Scope: "deep", Filter: "(uid=ada)"}); r.Failure == nil {
		t.Fatal("an unknown scope should be refused")
	}
	many := make([]string, 13)
	for i := range many {
		many[i] = "attr" + string(rune('a'+i))
	}
	if r := d.Search(ctx, id, SearchRequest{Scope: "sub", Filter: "(uid=ada)", Attributes: many}); r.Failure == nil {
		t.Fatal("13 columns should be refused")
	}
	if len(srv.Requests()) != before {
		t.Fatalf("%d searches reached the server", len(srv.Requests())-before)
	}
}

func TestSearchWordsServerErrorsAndStops(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(5), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)

	missing := d.Search(context.Background(), id, SearchRequest{Base: "ou=nowhere," + fakeBase, Scope: "sub", Filter: "(uid=ada)"})
	if missing.Failure == nil || missing.Failure.Code != 32 || missing.Failure.Lost {
		t.Fatalf("got %+v", missing.Failure)
	}
	stopped, stop := context.WithCancel(context.Background())
	stop()
	r := d.Search(stopped, id, SearchRequest{Scope: "sub", Filter: "(uid=*)"})
	if r.Failure == nil || r.Failure.Title != "Search stopped." {
		t.Fatalf("got %+v", r.Failure)
	}
	// Stopping leaves the connection usable.
	if again := d.Search(context.Background(), id, SearchRequest{Scope: "sub", Filter: "(uid=user0001)"}); again.Failure != nil || len(again.Rows) != 1 {
		t.Fatalf("after a stop: %+v", again)
	}
	if r := d.Search(context.Background(), "nope", SearchRequest{Scope: "sub"}); r.Failure == nil || !r.Failure.Lost {
		t.Fatalf("not connected: %+v", r.Failure)
	}
}

func TestCheckFilterAndAttributeNames(t *testing.T) {
	d := NewDirectoryService(nil, newTestService(t))
	if c := d.CheckFilter("(&(uid=ada)"); c.OK || c.Position != 11 || c.Message == "" {
		t.Fatalf("got %+v", c)
	}
	if c := d.CheckFilter("(uid=ada)"); !c.OK {
		t.Fatalf("got %+v", c)
	}
	if names := d.AttributeNames("not-connected"); names == nil || len(names) != 0 {
		t.Fatalf("got %v", names)
	}
}

func TestTreeOnAServerThatSaysNothingAboutChildren(t *testing.T) {
	// No paging, no child counts, and the server stops listings at 300.
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{SizeLimit: 300})
	d, id, _ := connectFake(t, srv)
	people := d.Children(context.Background(), id, fakePeople, "")
	if people.Failure != nil {
		t.Fatalf("failure %+v", people.Failure)
	}
	if people.Total != 300 || !people.Truncated || !people.ServerLimit {
		t.Fatalf("total %d truncated %v serverLimit %v", people.Total, people.Truncated, people.ServerLimit)
	}
	for _, n := range people.Nodes {
		if n.HasChildren || n.Count != -1 {
			t.Fatalf("a person is a leaf, whatever the server says: %+v", n)
		}
	}
	top := d.Children(context.Background(), id, fakeBase, "")
	kinds := map[string]bool{}
	for _, n := range top.Nodes {
		kinds[n.RDN] = n.HasChildren
	}
	// Containers are expandable by their class; the server never said they have entries.
	if !kinds["ou=people"] || !kinds["ou=groups"] {
		t.Fatalf("containers should offer to expand: %v", kinds)
	}
	groups := d.Children(context.Background(), id, "ou=groups,"+fakeBase, "")
	if len(groups.Nodes) != 1 || groups.Nodes[0].HasChildren || groups.Nodes[0].Type != "group" {
		t.Fatalf("a group is a leaf: %+v", groups.Nodes)
	}
}
