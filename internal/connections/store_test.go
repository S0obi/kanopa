package connections

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "Kanopa", "connections.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return s, path
}

func conn(id, name string) Connection {
	return Connection{ID: id, Name: name, URL: "ldaps://ldap.example.org", Security: "ldaps", Bind: "simple",
		BindDN: "cn=admin,dc=example,dc=org", TimeoutSeconds: 10, PageSize: 500, Referrals: "show", VerifyCert: true}
}

func TestMissingFileIsEmpty(t *testing.T) {
	s, _ := newStore(t)
	if len(s.List()) != 0 || s.Notice() != "" {
		t.Fatal("a missing file should be an empty list with no notice")
	}
}

func TestRoundTripKeepsOrder(t *testing.T) {
	s, path := newStore(t)
	for _, c := range []Connection{conn("a", "Production"), conn("b", "Staging"), conn("c", "Local")} {
		if err := s.Put(c, ""); err != nil {
			t.Fatal(err)
		}
	}
	// A duplicate goes right after its original.
	if err := s.Put(conn("a2", "Production (copy)"), "a"); err != nil {
		t.Fatal(err)
	}
	re, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range re.List() {
		names = append(names, c.Name)
	}
	if got := strings.Join(names, ","); got != "Production,Production (copy),Staging,Local" {
		t.Fatalf("order = %s", got)
	}
}

func TestUpdateAndDelete(t *testing.T) {
	s, path := newStore(t)
	_ = s.Put(conn("a", "Production"), "")
	if _, err := s.Update("a", func(c *Connection) { c.Name = "Prod" }); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if _, err := s.Update("a", func(*Connection) {}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	re, _ := Open(path)
	if len(re.List()) != 0 {
		t.Fatal("delete was not saved")
	}
}

func TestFileNeverHoldsAPassword(t *testing.T) {
	s, path := newStore(t)
	_ = s.Put(conn("a", "Production"), "")
	data, _ := os.ReadFile(path)
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(data)), `"password"`) {
		t.Fatalf("the file has a password field: %s", data)
	}
	if raw["version"].(float64) != Version {
		t.Fatalf("version = %v", raw["version"])
	}
}

func TestDamagedFileIsMovedAside(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connections.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	n := s.Notice()
	if !strings.Contains(n, "couldn't read your saved connections") || !strings.Contains(n, ".unreadable-") {
		t.Fatalf("notice = %q", n)
	}
	if s.Notice() != "" {
		t.Fatal("the notice should show once")
	}
	matches, _ := filepath.Glob(path + ".unreadable-*")
	if len(matches) != 1 {
		t.Fatalf("damaged file not kept: %v", matches)
	}
	if err := s.Put(conn("a", "New"), ""); err != nil {
		t.Fatal(err)
	}
}

func TestOldFileIsMigrated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connections.json")
	if err := os.WriteFile(path, []byte(`{"connections":[{"id":"a","name":"Old","url":"ldap://h","referrals":"follow"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := s.Get("a")
	if c.TimeoutSeconds != 10 || c.PageSize != 500 || c.Referrals != "show" {
		t.Fatalf("defaults not applied: %+v", c)
	}
}

func TestNewerFileIsNeverOverwritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connections.json")
	original := `{"version":99,"connections":[{"id":"a","name":"Future"}]}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := Open(path)
	if !strings.Contains(s.Notice(), "newer Kanopa") {
		t.Fatal("expected a notice")
	}
	if len(s.List()) != 1 {
		t.Fatal("connections should still be listed")
	}
	if err := s.Put(conn("b", "New"), ""); err == nil {
		t.Fatal("writing should be refused")
	}
	if data, _ := os.ReadFile(path); string(data) != original {
		t.Fatal("the newer file was changed")
	}
}
