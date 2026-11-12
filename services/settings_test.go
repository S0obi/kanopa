package services

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/S0obi/kanopa/internal/settings"
)

func newSettingsService(t *testing.T, chrome func(bool)) *SettingsService {
	t.Helper()
	store, err := settings.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	return NewSettingsService(slog.New(slog.NewTextHandler(io.Discard, nil)), store, chrome)
}

func TestThemeIsSavedAndRefusesUnknownChoices(t *testing.T) {
	s := newSettingsService(t, nil)
	if got := s.Theme(); got != "system" {
		t.Fatalf("theme = %q, want system", got)
	}
	if err := s.SetTheme("dark"); err != nil {
		t.Fatal(err)
	}
	if got := s.Theme(); got != "dark" {
		t.Fatalf("theme = %q, want dark", got)
	}
	if err := s.SetTheme("sepia"); err == nil {
		t.Fatal("expected an error for an unknown theme")
	}
}

func TestAppearancePaintsTheWindow(t *testing.T) {
	var dark []bool
	s := newSettingsService(t, func(d bool) { dark = append(dark, d) })
	for _, resolved := range []string{"dark", "light"} {
		if err := s.SetAppearance(resolved); err != nil {
			t.Fatal(err)
		}
	}
	if len(dark) != 2 || !dark[0] || dark[1] {
		t.Fatalf("chrome calls = %v, want [true false]", dark)
	}
	if err := s.SetAppearance("system"); err == nil {
		t.Fatal("the window is painted for a resolved theme, not for system")
	}
}

func TestRecentSearchesBelongToAConnectionAndGoWithIt(t *testing.T) {
	prefs := newSettingsService(t, nil)
	conns := newTestService(t)
	conns.AfterDelete = func(id string) { _ = prefs.ClearRecentSearches(id) }
	c, err := conns.Save(SaveRequest{Name: "Prod", URL: "ldaps://ldap.example.org", Security: "ldaps", Bind: "anonymous", TimeoutSeconds: 5})
	if err != nil {
		t.Fatal(err)
	}
	if got := prefs.RecentSearches(c.ID); got == nil || len(got) != 0 {
		t.Fatalf("a new connection has none, as an empty list: %v", got)
	}
	for _, f := range []string{"(uid=ada)", "(uid=alan)", "(uid=ada)"} {
		if err := prefs.AddRecentSearch(c.ID, RecentSearch{Base: "dc=example,dc=org", Scope: "sub", Filter: f}); err != nil {
			t.Fatal(err)
		}
	}
	got := prefs.RecentSearches(c.ID)
	if len(got) != 2 || got[0].Filter != "(uid=ada)" || got[1].Filter != "(uid=alan)" || got[0].Attrs == nil {
		t.Fatalf("got %+v", got)
	}
	if err := prefs.ClearRecentSearches(c.ID); err != nil || len(prefs.RecentSearches(c.ID)) != 0 {
		t.Fatal("clearing should empty the list")
	}
	_ = prefs.AddRecentSearch(c.ID, RecentSearch{Scope: "sub", Filter: "(cn=x)"})
	if err := conns.Delete(c.ID); err != nil {
		t.Fatal(err)
	}
	if len(prefs.RecentSearches(c.ID)) != 0 {
		t.Fatal("deleting a connection should forget its recent searches")
	}
}
