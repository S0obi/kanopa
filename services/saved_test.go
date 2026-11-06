package services

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/connections"
	"github.com/S0obi/kanopa/internal/ldapx"
	"github.com/S0obi/kanopa/internal/secrets"
)

func req(name string) SaveRequest {
	return SaveRequest{Name: name, URL: "ldaps://ldap.example.org", Security: "ldaps", Bind: "simple",
		BindDN: "cn=admin,dc=example,dc=org", Password: "s3cret", SavePassword: true, TimeoutSeconds: 10, PageSize: 500,
		Referrals: "show", VerifyCert: true}
}

func TestSaveValidates(t *testing.T) {
	s := newTestService(t)
	for _, c := range []struct {
		mut  func(*SaveRequest)
		want string
	}{
		{func(r *SaveRequest) { r.Name = " " }, "Enter a name for this connection."},
		{func(r *SaveRequest) { r.URL = "example.org" }, "Enter an LDAP URL such as ldaps://ldap.example.org:636."},
		{func(r *SaveRequest) { r.BindDN = "" }, "Enter a bind DN, or choose Anonymous."},
		{func(r *SaveRequest) { r.URL, r.Security = "ldap://h", "ldaps" }, "LDAPS needs an ldaps:// URL."},
	} {
		r := req("Production")
		c.mut(&r)
		if _, err := s.Save(r); err == nil || !strings.HasPrefix(err.Error(), c.want) {
			t.Errorf("err = %v, want %q", err, c.want)
		}
	}
	if len(s.List().Connections) != 0 {
		t.Fatal("nothing should have been saved")
	}
}

func TestSaveKeepsThePasswordOutOfTheFile(t *testing.T) {
	s, mem := newTestServiceWith(t)
	c, err := s.Save(req("Production"))
	if err != nil {
		t.Fatal(err)
	}
	if c.ID == "" || c.URL != "ldaps://ldap.example.org:636" || !c.HasPassword {
		t.Fatalf("unexpected %+v", c)
	}
	if pw, _ := mem.Get(c.ID); pw != "s3cret" {
		t.Fatalf("password in store = %q", pw)
	}

	// Editing with an empty password keeps the saved one.
	r := req("Prod")
	r.ID, r.Password = c.ID, ""
	if _, err := s.Save(r); err != nil {
		t.Fatal(err)
	}
	if pw, _ := mem.Get(c.ID); pw != "s3cret" {
		t.Fatal("an empty password replaced the saved one")
	}

	// Unticking "Save the password" removes it.
	r.SavePassword = false
	got, _ := s.Save(r)
	if _, err := mem.Get(c.ID); err != secrets.ErrNotFound || got.HasPassword {
		t.Fatal("the saved password should be gone")
	}
}

func TestAnonymousDropsCredentials(t *testing.T) {
	s, mem := newTestServiceWith(t)
	r := req("Public")
	r.Bind = "anonymous"
	c, _ := s.Save(r)
	if c.BindDN != "" || c.SavePassword || mem.Len() != 0 {
		t.Fatalf("anonymous kept credentials: %+v", c)
	}
}

func TestDuplicateAndDelete(t *testing.T) {
	s, mem := newTestServiceWith(t)
	a, _ := s.Save(req("Production"))
	b, _ := s.Save(req("Staging"))
	d, err := s.Duplicate(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "Production (copy)" || d.ID == a.ID || !d.HasPassword {
		t.Fatalf("unexpected copy %+v", d)
	}
	var names []string
	for _, c := range s.List().Connections {
		names = append(names, c.Name)
	}
	if strings.Join(names, ",") != "Production,Production (copy),Staging" {
		t.Fatalf("order = %v", names)
	}
	if err := s.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := mem.Get(a.ID); err != secrets.ErrNotFound {
		t.Fatal("delete should remove the saved password")
	}
	if _, err := mem.Get(d.ID); err != nil {
		t.Fatal("the copy keeps its own password")
	}
	if err := s.Delete(a.ID); err == nil {
		t.Fatal("deleting twice should say the connection is gone")
	}
	_ = b
}

func TestConnectAsksBeforeUnencrypted(t *testing.T) {
	s := newTestService(t)
	opened := false
	s.open = func(context.Context, ldapx.Params) (*ldapx.Session, error) {
		opened = true
		return nil, ldapx.Classify(ldapErr49(), ldapx.Op{})
	}
	r := req("Local")
	r.URL, r.Security = "ldap://localhost", "none"
	c, _ := s.Save(r)
	if res := s.Connect(context.Background(), c.ID, "", false); res.Reason != ReasonNeedsConsent || opened {
		t.Fatalf("want consent first, got %+v (opened=%v)", res, opened)
	}
	_ = s.AllowUnencrypted(c.ID)
	if res := s.Connect(context.Background(), c.ID, "", false); res.Reason != ReasonBadPassword || !opened {
		t.Fatalf("want a bind attempt, got %+v", res)
	}
	// A new host asks again.
	r.ID, r.URL = c.ID, "ldap://other.example.org"
	saved, _ := s.Save(r)
	if saved.PlainConsent {
		t.Fatal("consent should not follow a changed URL")
	}
}

func TestConnectAsksForAMissingPassword(t *testing.T) {
	s := newTestService(t)
	r := req("Production")
	r.SavePassword, r.Password = false, ""
	c, _ := s.Save(r)
	res := s.Connect(context.Background(), c.ID, "", false)
	if res.Reason != ReasonNeedsPassword || res.Message != "Enter the password for cn=admin,dc=example,dc=org." {
		t.Fatalf("unexpected %+v", res)
	}
}

func TestFailedConnectIsRemembered(t *testing.T) {
	s := newTestService(t)
	s.open = func(context.Context, ldapx.Params) (*ldapx.Session, error) {
		return nil, ldapx.Classify(ldapErr49(), ldapx.Op{BindDN: "cn=admin,dc=example,dc=org"})
	}
	c, _ := s.Save(req("Production"))
	res := s.Connect(context.Background(), c.ID, "", false)
	if res.OK || res.Reason != ReasonBadPassword || res.Code != 49 {
		t.Fatalf("unexpected %+v", res)
	}
	if got := s.List().Connections[0].LastError; !strings.HasSuffix(got, "Invalid credentials (49)") {
		t.Fatalf("lastError = %q", got)
	}
}

func TestTestUsesTheSavedPassword(t *testing.T) {
	s := newTestService(t)
	c, _ := s.Save(req("Production"))
	var got string
	s.open = func(_ context.Context, p ldapx.Params) (*ldapx.Session, error) { got = p.Password; return nil, ldapErr49() }
	s.Test(context.Background(), ConnectionParams{URL: c.URL, Security: "ldaps", Bind: "simple", BindDN: c.BindDN, ConnectionID: c.ID})
	if got != "s3cret" {
		t.Fatalf("password used = %q", got)
	}
}

// spySecrets counts reads and can fail writes.
type spySecrets struct {
	*secrets.Memory
	gets    int
	failSet bool
}

func (s *spySecrets) Get(id string) (string, error) { s.gets++; return s.Memory.Get(id) }
func (s *spySecrets) Set(id, pw string) error {
	if s.failSet {
		return errors.New("access denied")
	}
	return s.Memory.Set(id, pw)
}

func newSpyService(t *testing.T, store *connections.Store) (*ConnectionService, *spySecrets) {
	t.Helper()
	spy := &spySecrets{Memory: secrets.NewMemory()}
	svc := NewConnectionService(slog.New(slog.NewTextHandler(io.Discard, nil)), store, spy)
	t.Cleanup(func() { _ = svc.ServiceShutdown() })
	return svc, spy
}

func openStore(t *testing.T, content string) *connections.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "connections.json")
	if content != "" {
		os.WriteFile(path, []byte(content), 0o600)
	}
	st, err := connections.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestListNeverReadsPasswords(t *testing.T) {
	s, spy := newSpyService(t, openStore(t, ""))
	for _, n := range []string{"A", "B", "C"} {
		if _, err := s.Save(req(n)); err != nil {
			t.Fatal(err)
		}
	}
	spy.gets = 0
	l := s.List()
	if spy.gets != 0 {
		t.Fatalf("List read %d passwords", spy.gets)
	}
	if !l.Connections[0].HasPassword {
		t.Fatal("HasPassword should come from the saved flag")
	}
}

func TestNewConnectionWithoutPasswordIsNotSaved(t *testing.T) {
	s := newTestService(t)
	r := req("No password")
	r.Password = ""
	c, _ := s.Save(r)
	if c.SavePassword || c.HasPassword {
		t.Fatalf("nothing to save, got %+v", c)
	}
}

func TestFailedFileWriteLeavesTheCredentialStoreAlone(t *testing.T) {
	// A file from a newer Kanopa: listed, never written.
	st := openStore(t, `{"version":99,"connections":[{"id":"a","name":"A","url":"ldaps://h:636","security":"ldaps","bind":"simple","bindDn":"cn=x","savePassword":true}]}`)
	s, spy := newSpyService(t, st)
	_ = spy.Memory.Set("a", "kept")

	r := req("A")
	r.ID, r.URL, r.SavePassword, r.Password = "a", "ldaps://h:636", false, ""
	if _, err := s.Save(r); err == nil {
		t.Fatal("saving should fail")
	}
	if err := s.Delete("a"); err == nil {
		t.Fatal("deleting should fail")
	}
	if pw, _ := spy.Memory.Get("a"); pw != "kept" {
		t.Fatal("the saved password must survive a failed save or delete")
	}
	if _, err := s.Save(req("New")); err == nil {
		t.Fatal("saving a new connection should fail")
	}
	if spy.Memory.Len() != 1 {
		t.Fatal("a failed save must not leave a password behind")
	}
}

func TestPasswordThatCannotBeStoredIsReported(t *testing.T) {
	s, spy := newSpyService(t, openStore(t, ""))
	spy.failSet = true
	_, err := s.Save(req("Production"))
	if err == nil || !strings.HasPrefix(err.Error(), "The connection is saved, but not its password:") {
		t.Fatalf("err = %v", err)
	}
	if c := s.List().Connections[0]; c.SavePassword || c.HasPassword {
		t.Fatalf("the connection should not claim a saved password: %+v", c)
	}
}

