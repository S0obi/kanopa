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

func TestLayoutKeepsOnlyWhatCanBeRight(t *testing.T) {
	s := newSettingsService(t, nil)
	if l := s.Layout(); l.SidebarWidth != 0 || l.Tab != "" {
		t.Fatalf("nothing saved: %+v", l)
	}
	if err := s.SetLayout(Layout{SidebarWidth: 340, Tab: "members"}); err != nil {
		t.Fatal(err)
	}
	if l := s.Layout(); l.SidebarWidth != 340 || l.Tab != "members" {
		t.Fatalf("got %+v", l)
	}
	// A width or a tab nothing offers is dropped, not kept.
	if err := s.SetLayout(Layout{SidebarWidth: 5, Tab: "settings"}); err != nil {
		t.Fatal(err)
	}
	if l := s.Layout(); l.SidebarWidth != 0 || l.Tab != "" {
		t.Fatalf("got %+v", l)
	}
}
