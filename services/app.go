package services

import (
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
)

// EventCloseRequested is emitted when the person closes the window while changes are pending.
// The frontend asks them, then calls AppService.CloseAnyway.
const EventCloseRequested = "kanopa:close-requested"

// License and home of Kanopa, as About shows them.
const (
	licenseName = "MIT"
	repoURL     = "https://github.com/S0obi/kanopa"
)

// maxClientError bounds what the interface can write to the log about a crash.
const maxClientError = 4000

// AppConfig is what main gives the AppService.
type AppConfig struct {
	// Close closes the main window.
	Close func()
	// Version is the Kanopa version; Webview describes the web engine the window runs on, once known.
	Version string
	Webview func() string
	// LogDir is the folder of the log file; OpenPath opens a folder in the file manager.
	LogDir   string
	OpenPath func(path string) error
	// OpenURL opens an address in the person's browser.
	OpenURL func(url string) error
	Log     *slog.Logger
}

// AppService guards the window against closing with changes that were never applied, and tells
// the person what they are running.
type AppService struct {
	cfg AppConfig

	mu      sync.Mutex
	pending int
	closing bool
}

// NewAppService returns the service for cfg.
func NewAppService(cfg AppConfig) *AppService {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &AppService{cfg: cfg}
}

// SetPendingChanges tells Go how many entries have unapplied changes.
func (a *AppService) SetPendingChanges(n int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pending = max(n, 0)
}

// ShouldBlockClose reports whether a close must wait for the person's answer.
func (a *AppService) ShouldBlockClose() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pending > 0 && !a.closing
}

// CloseAnyway closes the window, dropping the pending changes.
func (a *AppService) CloseAnyway() {
	a.mu.Lock()
	a.closing = true
	f := a.cfg.Close
	a.mu.Unlock()
	if f != nil {
		f()
	}
}

// About is what the About dialog shows.
type About struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Commit  string `json:"commit"` // the source revision, when the build knows it
	System  string `json:"system"` // operating system and architecture
	Webview string `json:"webview"`
	Go      string `json:"go"`
	License string `json:"license"`
	Repo    string `json:"repo"`
	LogDir  string `json:"logDir"`
}

// revision is the short source revision the binary was built from, when it carries one.
func revision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" && len(s.Value) >= 7 {
			return s.Value[:7]
		}
	}
	return ""
}

// About returns the version and the system Kanopa runs on.
func (a *AppService) About() About {
	webview := ""
	if a.cfg.Webview != nil {
		webview = a.cfg.Webview()
	}
	return About{Name: "Kanopa", Version: a.cfg.Version, Commit: revision(), System: runtime.GOOS + " " + runtime.GOARCH,
		Webview: webview, Go: runtime.Version(), License: licenseName, Repo: repoURL, LogDir: a.cfg.LogDir}
}

// Diagnostics is text to paste into a bug report: versions and the system, and nothing that
// names a server, an entry or a person.
func (a *AppService) Diagnostics() string {
	ab := a.About()
	var b strings.Builder
	fmt.Fprintf(&b, "Kanopa %s", ab.Version)
	if ab.Commit != "" {
		fmt.Fprintf(&b, " (%s)", ab.Commit)
	}
	fmt.Fprintf(&b, "\nSystem: %s\n", ab.System)
	if ab.Webview != "" {
		fmt.Fprintf(&b, "Web engine: %s\n", ab.Webview)
	}
	fmt.Fprintf(&b, "Go: %s\n", ab.Go)
	return b.String()
}

// OpenLogFolder shows the folder of the log file in the file manager.
func (a *AppService) OpenLogFolder() error {
	if a.cfg.OpenPath == nil || a.cfg.LogDir == "" {
		return errors.New("Kanopa doesn't have a log folder to open.")
	}
	if err := a.cfg.OpenPath(a.cfg.LogDir); err != nil {
		a.cfg.Log.Warn("open log folder", "err", err)
		return fmt.Errorf("Kanopa couldn't open %s: %w", a.cfg.LogDir, err)
	}
	return nil
}

// OpenRepo opens Kanopa's home page in the browser. It opens that address only, so a link in the
// interface can't be made to open anything else.
func (a *AppService) OpenRepo() error {
	if a.cfg.OpenURL == nil {
		return errors.New("Kanopa can't open a browser here.")
	}
	return a.cfg.OpenURL(repoURL)
}

// LogClientError writes an error the interface caught (a crash) to the log, with its stack, so
// it is in the log folder next to the person's bug report. The text is shortened; it never
// carries a password.
func (a *AppService) LogClientError(message, stack string) {
	a.cfg.Log.Error("interface error", "message", clip(message), "stack", clip(stack))
}

func clip(s string) string {
	if r := []rune(s); len(r) > maxClientError {
		return string(r[:maxClientError]) + "…"
	}
	return s
}
