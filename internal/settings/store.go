// Package settings keeps Kanopa's own preferences (not connections): today the theme.
//
// It is a small versioned JSON file beside connections.json. A file that can't be read is
// moved aside and Kanopa starts with defaults; a file from a newer Kanopa is read but never
// overwritten.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Version is the file format this Kanopa writes.
const Version = 1

// Theme choices. System follows the operating system.
const (
	ThemeSystem = "system"
	ThemeLight  = "light" // Clearing
	ThemeDark   = "dark"  // Night forest
)

// ValidTheme reports whether t is one of the theme choices.
func ValidTheme(t string) bool { return t == ThemeSystem || t == ThemeLight || t == ThemeDark }

// Window is where the window was: its place and size in device-independent pixels, and whether it
// was maximized.
type Window struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized"`
}

// Valid reports whether the saved size is one a window can have.
func (w Window) Valid() bool {
	return w.Width >= 200 && w.Height >= 200 && w.Width <= 20000 && w.Height <= 20000
}

// Layout is what the interface remembers between runs: the tree pane's width and the entry view's tab.
type Layout struct {
	SidebarWidth int    `json:"sidebarWidth"`
	Tab          string `json:"tab"`
}

type file struct {
	Version int     `json:"version"`
	Theme   string  `json:"theme"`
	Window  *Window `json:"window,omitempty"`
	Layout  *Layout `json:"layout,omitempty"`
}

// Store is the settings file. Safe for concurrent use.
type Store struct {
	path     string
	mu       sync.Mutex
	theme    string
	window   *Window
	layout   Layout
	notice   string
	readOnly bool
}

// DefaultPath is <user config dir>/Kanopa/settings.json.
func DefaultPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "Kanopa", "settings.json"), nil
}

// Open reads the file at path. A missing file is the defaults. A file that is not valid JSON is
// moved aside, so the app still starts, and Notice says where it went.
func Open(path string) (*Store, error) {
	s := &Store{path: path, theme: ThemeSystem}
	data, err := os.ReadFile(path) //nolint:gosec // G304: Kanopa's own settings file, from os.UserConfigDir()
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		aside := fmt.Sprintf("%s.unreadable-%s", path, time.Now().Format("20060102-150405"))
		if rerr := os.Rename(path, aside); rerr != nil {
			return nil, fmt.Errorf("the settings file %s is damaged and couldn't be moved aside: %w", path, rerr)
		}
		s.notice = fmt.Sprintf("Kanopa couldn't read its settings, so it started with the defaults. The damaged file is kept as %s.", aside)
		return s, nil
	}
	if f.Version > Version {
		s.readOnly = true
	}
	if ValidTheme(f.Theme) {
		s.theme = f.Theme
	}
	if f.Window != nil && f.Window.Valid() {
		s.window = f.Window
	}
	if f.Layout != nil {
		s.layout = *f.Layout
	}
	return s, nil
}

// Unavailable is a store that could not be opened: it holds the defaults and saves nothing.
func Unavailable(path string, err error) *Store {
	return &Store{path: path, theme: ThemeSystem, readOnly: true,
		notice: fmt.Sprintf("Kanopa couldn't open its settings (%v). Check the permissions of %s, then restart Kanopa.", err, path)}
}

// Notice returns, then clears, the message about how the file was read.
func (s *Store) Notice() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.notice
	s.notice = ""
	return n
}

// Theme is the saved theme choice: system, light or dark.
func (s *Store) Theme() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.theme
}

// SetTheme keeps the choice for this run and saves it. When the file can't be saved the choice
// still holds until Kanopa closes, and the error says why it won't last.
func (s *Store) SetTheme(t string) error {
	if !ValidTheme(t) {
		return fmt.Errorf("Kanopa has no theme called %q.", t)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.theme = t
	return s.save()
}

// Window is where the window was when Kanopa last closed; ok is false when nothing usable was saved.
func (s *Store) Window() (w Window, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.window == nil {
		return Window{}, false
	}
	return *s.window, true
}

// SetWindow keeps and saves where the window is. A size no window can have is refused.
func (s *Store) SetWindow(w Window) error {
	if !w.Valid() {
		return fmt.Errorf("Kanopa can't remember a window of %d by %d.", w.Width, w.Height)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.window = &w
	return s.save()
}

// Layout is the remembered layout; its zero value means nothing was saved.
func (s *Store) Layout() Layout {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.layout
}

// SetLayout keeps and saves the layout.
func (s *Store) SetLayout(l Layout) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.layout = l
	return s.save()
}

// save writes the file (temp file + rename, so a crash never leaves half a file).
func (s *Store) save() error {
	if s.readOnly {
		return errors.New("Your settings were saved by a newer Kanopa, so this one can't change them. Update Kanopa to keep the theme between runs.")
	}
	data, err := json.MarshalIndent(file{Version: Version, Theme: s.theme, Window: s.window, Layout: &s.layout}, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("Kanopa couldn't create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".settings-*.json")
	if err != nil {
		return fmt.Errorf("Kanopa couldn't save its settings: %w", err)
	}
	_, werr := tmp.Write(append(data, '\n'))
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("Kanopa couldn't save its settings: %w", errors.Join(werr, cerr))
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("Kanopa couldn't save its settings: %w", err)
	}
	return nil
}
