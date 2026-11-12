package settings

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMissingFileIsSystemTheme(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Theme(); got != ThemeSystem {
		t.Fatalf("theme = %q, want system", got)
	}
}

func TestThemeSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "settings.json")
	s, _ := Open(path)
	if err := s.SetTheme(ThemeDark); err != nil {
		t.Fatal(err)
	}
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.Theme(); got != ThemeDark {
		t.Fatalf("theme = %q, want dark", got)
	}
}

func TestUnknownThemeIsRefusedAndIgnoredOnRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s, _ := Open(path)
	if err := s.SetTheme("neon"); err == nil {
		t.Fatal("expected an error for an unknown theme")
	}
	if got := s.Theme(); got != ThemeSystem {
		t.Fatalf("theme = %q after a refused change, want system", got)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"theme":"neon"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	again, _ := Open(path)
	if got := again.Theme(); got != ThemeSystem {
		t.Fatalf("theme = %q from a bad file, want system", got)
	}
}

func TestDamagedFileIsMovedAside(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Theme() != ThemeSystem {
		t.Fatalf("theme = %q, want the default", s.Theme())
	}
	if n := s.Notice(); !strings.Contains(n, "unreadable-") {
		t.Fatalf("notice = %q, want the aside name", n)
	}
	if s.Notice() != "" {
		t.Fatal("the notice should show once")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the damaged file should have been moved")
	}
}

func TestNewerFileIsReadButNeverOverwritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	body := `{"version":99,"theme":"dark","future":true}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := Open(path)
	if s.Theme() != ThemeDark {
		t.Fatalf("theme = %q, want dark from the newer file", s.Theme())
	}
	if err := s.SetTheme(ThemeLight); err == nil {
		t.Fatal("expected a refusal to overwrite a newer file")
	}
	// The choice holds for this run, and the file is untouched.
	if s.Theme() != ThemeLight {
		t.Fatalf("theme = %q, want light for this run", s.Theme())
	}
	got, _ := os.ReadFile(path)
	if string(got) != body {
		t.Fatalf("the newer file was changed: %s", got)
	}
}
