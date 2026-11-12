package services

import (
	"context"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/fakeldap"
)

const fakeBase = "dc=example,dc=org"
const fakePeople = "ou=people," + fakeBase

func entry(dn string, attrs map[string][]string) fakeldap.Entry {
	return fakeldap.Entry{DN: dn, Attrs: attrs}
}

func fakeDirectory(n int) []fakeldap.Entry {
	person := []string{"inetOrgPerson", "organizationalPerson", "person", "top"}
	top := []fakeldap.Entry{
		entry(fakeBase, map[string][]string{"objectClass": {"dcObject", "organization", "top"}, "dc": {"example"}}),
		entry(fakePeople, map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"people"}, "description": {"People"}}),
		entry("ou=groups,"+fakeBase, map[string][]string{"objectClass": {"organizationalUnit", "top"}, "ou": {"groups"}}),
		entry("cn=admins,ou=groups,"+fakeBase, map[string][]string{"objectClass": {"groupOfNames", "top"}, "cn": {"admins"}, "member": {"uid=ada," + fakePeople}}),
		entry("cn=Canada Team,ou=groups,"+fakeBase, map[string][]string{"objectClass": {"groupOfNames", "top"}, "cn": {"Canada Team"}, "description": {"Toronto office"}}),
		entry("uid=adamson,"+fakePeople, map[string][]string{"objectClass": person, "uid": {"adamson"}, "cn": {"Bob Adamson"}, "sn": {"Adamson"}, "givenName": {"Bob"}, "mail": {"bob.adamson@example.org"}}),
		entry("uid=ada,"+fakePeople, map[string][]string{"objectClass": person, "uid": {"ada"}, "cn": {"Ada Lovelace"}, "sn": {"Lovelace"}, "givenName": {"Ada"}, "mail": {"ada@example.org"}, "description": {"Mathematician"}}),
		entry("uid=grace,"+fakePeople, map[string][]string{"objectClass": person, "uid": {"grace"}, "cn": {"Grace Hopper"}, "sn": {"Hopper"}, "givenName": {"Grace"}, "mail": {"grace@example.org"}}),
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

func names(r QuickResult) []string {
	var out []string
	for _, h := range r.Hits {
		out = append(out, h.Name)
	}
	return out
}

func TestQuickFilterTellsAnLDAPQueryFromWords(t *testing.T) {
	one := "(|(uid=ada*)(mail=ada*)(givenName=ada*)(cn=*ada*)(sn=*ada*)(displayName=*ada*)(ou=*ada*))"
	for _, tc := range []struct {
		text, mode, filter string
		words              int
	}{
		{"ada", ModeNames, one, 1},
		{"  ada  ", ModeNames, one, 1},
		{"ada lov", ModeNames, "(&" + one + strings.ReplaceAll(one, "ada", "lov") + ")", 2},
		{"(uid=ada)", ModeFilter, "(uid=ada)", 0},
		{"  (&(uid=ada)(mail=*))", ModeFilter, "(&(uid=ada)(mail=*))", 0},
		{"uid=ada", ModeFilter, "(uid=ada)", 0},
		{"cn=Ada Lovelace", ModeFilter, "(cn=Ada Lovelace)", 0},
		{"age>=18", ModeFilter, "(age>=18)", 0},
		{"mail=*@example.org", ModeFilter, "(mail=*@example.org)", 0},
		{"+41 44 555", ModeNames, "", 3},
		{"1=1", ModeNames, "", 1}, // an attribute name starts with a letter
	} {
		mode, filter, words := quickFilter(tc.text)
		if mode != tc.mode || len(words) != tc.words || (tc.filter != "" && filter != tc.filter) {
			t.Errorf("%q: mode %s, %d words, filter %q; want %s, %d, %q", tc.text, mode, len(words), filter, tc.mode, tc.words, tc.filter)
		}
	}
}

func TestQuickFilterEscapesWhatTheWordHolds(t *testing.T) {
	_, filter, _ := quickFilter(`a*b (c) d\e`)
	for _, bad := range []string{"a*b", "(c)", `d\e`} {
		if strings.Contains(filter, bad) {
			t.Errorf("%q should be escaped in %s", bad, filter)
		}
	}
	for _, want := range []string{`a\2ab`, `\28c\29`, `d\5ce`} {
		if !strings.Contains(filter, want) {
			t.Errorf("%s should hold %q", filter, want)
		}
	}
	_, many, words := quickFilter("a1 b2 c3 d4 e5 f6 g7 h8")
	if len(words) != 6 || strings.Contains(many, "g7") {
		t.Errorf("only the first %d words count: %v", quickWords, words)
	}
}

func TestQuickFindRanksTheBestMatchFirst(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(0), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	r := d.Quick(context.Background(), id, "ada")
	if r.Failure != nil || r.Invalid != nil {
		t.Fatalf("got %+v %+v", r.Failure, r.Invalid)
	}
	// Exactly "ada" first; then names that start with it; then names that contain it.
	got := strings.Join(names(r), "|")
	if got != "Ada Lovelace|Bob Adamson|Canada Team" {
		t.Fatalf("got %s", got)
	}
	if r.Mode != ModeNames || r.Total != 3 || r.More || !r.Paged {
		t.Fatalf("mode %s total %d more %v paged %v", r.Mode, r.Total, r.More, r.Paged)
	}
	first := r.Hits[0]
	if first.Type != "person" || first.DN != "uid=ada,"+fakePeople || first.Sub != "ada@example.org" {
		t.Fatalf("first hit %+v", first)
	}
	if grp := r.Hits[2]; grp.Type != "group" || grp.Sub != "Toronto office" {
		t.Fatalf("group hit %+v", grp)
	}
}

func TestQuickFindWithSeveralWords(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(0), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	ctx := context.Background()
	if r := d.Quick(ctx, id, "ada lov"); len(r.Hits) != 1 || r.Hits[0].Name != "Ada Lovelace" {
		t.Fatalf("ada lov: %v", names(r))
	}
	if r := d.Quick(ctx, id, "lovelace ada"); len(r.Hits) != 1 {
		t.Fatalf("word order does not matter: %v", names(r))
	}
	// Mail counts as a name.
	if r := d.Quick(ctx, id, "grace@example"); len(r.Hits) != 1 || r.Hits[0].Name != "Grace Hopper" {
		t.Fatalf("mail: %v", names(r))
	}
	if r := d.Quick(ctx, id, "ada hopper"); len(r.Hits) != 0 {
		t.Fatalf("every word must match: %v", names(r))
	}
	if r := d.Quick(ctx, id, "zzzz"); r.Failure != nil || len(r.Hits) != 0 || r.Total != 0 {
		t.Fatalf("nothing matches: %+v", r)
	}
}

func TestQuickFindReadsTwoHundredAndShowsTen(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	r := d.Quick(context.Background(), id, "user")
	if r.Failure != nil || r.Total != 200 || !r.More || len(r.Hits) != 10 {
		t.Fatalf("total %d more %v hits %d failure %+v", r.Total, r.More, len(r.Hits), r.Failure)
	}
	// One round trip, whatever the page size of the connection.
	var searches int
	for _, q := range srv.Requests() {
		if strings.Contains(q.Filter, "user") {
			searches++
		}
	}
	if searches != 2 { // the page of 200, then the request that closes the cursor
		t.Fatalf("%d searches", searches)
	}
	if r := d.Quick(context.Background(), id, "user0007"); len(r.Hits) != 1 || r.Hits[0].DN != "uid=user0007,"+fakePeople || r.More {
		t.Fatalf("user0007: %+v", r.Hits)
	}
}

func TestQuickFindWithAnLDAPFilter(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(30), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	ctx := context.Background()

	r := d.Quick(ctx, id, "(&(objectClass=inetOrgPerson)(uid=user0007))")
	if r.Mode != ModeFilter || len(r.Hits) != 1 || r.Hits[0].Name != "User user0007" {
		t.Fatalf("got %+v", r)
	}
	bare := d.Quick(ctx, id, "uid=user0008")
	if bare.Filter != "(uid=user0008)" || len(bare.Hits) != 1 {
		t.Fatalf("a bare attribute=value is wrapped: %+v", bare)
	}
	// In the server's order, not ranked.
	all := d.Quick(ctx, id, "(objectClass=inetOrgPerson)")
	if all.Total != 33 || len(all.Hits) != 10 || all.More {
		t.Fatalf("total %d hits %d more %v", all.Total, len(all.Hits), all.More)
	}
}

func TestQuickFindRefusesAFilterItCannotSendWithoutSendingIt(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(3), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)
	before := len(srv.Requests())
	ctx := context.Background()

	bad := d.Quick(ctx, id, "(&(uid=ada)")
	if bad.Invalid == nil || bad.Invalid.Position != 11 || !strings.Contains(bad.Invalid.Message, "Missing )") || bad.Failure != nil || len(bad.Hits) != 0 {
		t.Fatalf("got %+v", bad)
	}
	// The parenthesis Kanopa adds around a bare attribute=value is not counted in the position.
	bare := d.Quick(ctx, id, "uid=a(b")
	if bare.Invalid == nil || bare.Invalid.Position != 5 {
		t.Fatalf("got %+v", bare.Invalid)
	}
	if one := d.Quick(ctx, id, "a"); len(one.Hits) != 0 || one.Invalid != nil || one.Failure != nil {
		t.Fatalf("a single character is not searched: %+v", one)
	}
	if len(srv.Requests()) != before {
		t.Fatalf("%d searches reached the server", len(srv.Requests())-before)
	}
}

func TestQuickFindOnAServerWithoutPaging(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{})
	d, id, info := connectFake(t, srv)
	if info.Paging {
		t.Fatal("the server lists its controls without paging")
	}
	r := d.Quick(context.Background(), id, "user")
	if r.Failure != nil || r.Total != 200 || !r.More || r.ServerLimit || r.Paged {
		t.Fatalf("total %d more %v serverLimit %v paged %v failure %+v", r.Total, r.More, r.ServerLimit, r.Paged, r.Failure)
	}
	last := srv.Requests()[len(srv.Requests())-1]
	if last.Paged || last.SizeLimit != 201 {
		t.Fatalf("one plain search asking for one more than the limit, got %+v", last)
	}
}

func TestQuickFindKeepsWhatAServerSizeLimitReturned(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(1200), fakeldap.Options{SizeLimit: 50})
	d, id, _ := connectFake(t, srv)
	r := d.Quick(context.Background(), id, "user")
	if r.Failure != nil {
		t.Fatalf("a size limit is not a failure: %+v", r.Failure)
	}
	if r.Total != 50 || !r.More || !r.ServerLimit || len(r.Hits) != 10 {
		t.Fatalf("total %d more %v serverLimit %v hits %d", r.Total, r.More, r.ServerLimit, len(r.Hits))
	}
}

func TestQuickFindStopsAndNeedsAConnection(t *testing.T) {
	srv := fakeldap.Start(t, fakeDirectory(5), fakeldap.Options{Paging: true})
	d, id, _ := connectFake(t, srv)

	stopped, stop := context.WithCancel(context.Background())
	stop()
	if r := d.Quick(stopped, id, "user"); r.Failure == nil || r.Failure.Title != "Search stopped." {
		t.Fatalf("got %+v", r.Failure)
	}
	// Stopping leaves the connection usable.
	if again := d.Quick(context.Background(), id, "user0001"); again.Failure != nil || len(again.Hits) != 1 {
		t.Fatalf("after a stop: %+v", again)
	}
	if r := d.Quick(context.Background(), "nope", "user"); r.Failure == nil || !r.Failure.Lost {
		t.Fatalf("not connected: %+v", r.Failure)
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
	if len(groups.Nodes) != 2 {
		t.Fatalf("got %d groups", len(groups.Nodes))
	}
	for _, g := range groups.Nodes {
		if g.HasChildren || g.Type != "group" {
			t.Fatalf("a group is a leaf: %+v", g)
		}
	}
}
