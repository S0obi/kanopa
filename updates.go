package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

const (
	releasesRepo = "S0obi/kanopa"
	releasesURL  = "https://github.com/" + releasesRepo + "/releases/latest"
)

// wailsUpdates adapts the Wails updater to services.UpdateEngine. The updater only exists once
// the application does, so it is attached afterwards.
type wailsUpdates struct {
	app *application.App

	mu       sync.Mutex
	progress func(written, total int64)
}

// newUpdateProvider reads releases from GitHub. Only stable releases are offered (no drafts, and no
// pre-releases unless this is itself a release candidate, so a dry run of a release can update a dry run), each download is checked against the SHA256SUMS file of its release, and the file picked is
// the one the app can swap in: the portable zip on Windows. macOS only learns that a new version exists.
func newUpdateProvider(baseURL string, prerelease bool) (updater.Provider, error) {
	gh, err := github.New(github.Config{
		Repository:    releasesRepo,
		BaseURL:       baseURL,
		Prerelease:    prerelease,
		ChecksumAsset: "SHA256SUMS",
		AssetMatcher:  pickAsset,
	})
	if err != nil {
		return nil, err
	}
	return needsChecksum{gh}, nil
}

// needsChecksum refuses a release that comes without a checksum for its file. The GitHub provider
// installs such a release without checking it, which is not what Kanopa wants.
type needsChecksum struct{ updater.Provider }

func (n needsChecksum) Check(ctx context.Context, req updater.CheckRequest) (*updater.Release, error) {
	rel, err := n.Provider.Check(ctx, req)
	if err != nil || rel == nil {
		return rel, err
	}
	if rel.Verification == nil || len(rel.Verification.Digest) == 0 {
		return nil, fmt.Errorf("release %s has no checksum for %s", rel.Version, rel.Artifact.Filename)
	}
	return rel, nil
}

// pickAsset chooses the release file for this system, or -1.
func pickAsset(req updater.CheckRequest, assets []github.ReleaseAsset) int {
	var suffix string
	switch req.Platform {
	case "windows":
		suffix = ".zip"
	case "darwin":
		suffix = ".dmg"
	default:
		return -1
	}
	for i, a := range assets {
		name := strings.ToLower(a.Name)
		if !strings.HasSuffix(name, suffix) {
			continue
		}
		if req.Platform == "windows" && (!strings.Contains(name, "windows") || !strings.Contains(name, req.Arch)) {
			continue
		}
		if req.Platform == "darwin" && !strings.Contains(name, "macos") {
			continue
		}
		return i
	}
	return -1
}

// attach connects the adapter to the running application and sets the updater up.
func (w *wailsUpdates) attach(app *application.App, version string, provider updater.Provider) error {
	w.app = app
	app.Event.On(updater.EventDownloadProgress, func(e *application.CustomEvent) {
		var p updater.Progress
		raw, err := json.Marshal(e.Data)
		if err != nil || json.Unmarshal(raw, &p) != nil {
			return
		}
		w.mu.Lock()
		fn := w.progress
		w.mu.Unlock()
		if fn != nil {
			fn(p.Written, p.Total)
		}
	})
	return app.Updater.Init(updater.Config{
		CurrentVersion: version,
		Providers:      []updater.Provider{provider},
		Window:         updater.WindowNone, // Kanopa draws its own banner
	})
}

func (w *wailsUpdates) Check(ctx context.Context) (string, error) {
	rel, err := w.app.Updater.Check(ctx)
	if err != nil || rel == nil {
		return "", err
	}
	return rel.Version, nil
}

func (w *wailsUpdates) Download(ctx context.Context, progress func(written, total int64)) error {
	w.mu.Lock()
	w.progress = progress
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		w.progress = nil
		w.mu.Unlock()
	}()
	return w.app.Updater.DownloadAndInstall(ctx)
}

func (w *wailsUpdates) Restart(ctx context.Context) error { return w.app.Updater.Restart(ctx) }

// canReplaceItself reports whether this install can swap its own program file for a new one:
// Windows, running from a folder the person can write to (a per-user install, or a portable copy
// they put somewhere of their own).
func canReplaceItself() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	f, err := os.CreateTemp(filepath.Dir(exe), ".kanopa-write-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}
