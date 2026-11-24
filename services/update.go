package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/S0obi/kanopa/internal/settings"
)

// Updating Kanopa. It is opt-in: nothing is contacted until the person says yes (or asks for a
// check by hand). A check asks GitHub for the latest stable release; when one is newer, and this
// install can replace itself, it is downloaded in the background and the person chooses when to
// restart. Otherwise the person is pointed at the Releases page.
//
// The page polls UpdateStatus, like it polls an export.

// Update states.
const (
	UpdateIdle        = "idle"        // nothing to say
	UpdateChecking    = "checking"    // asking for the latest release
	UpdateDownloading = "downloading" // a newer version is coming down
	UpdateReady       = "ready"       // downloaded and checked; Restart to update
	UpdateUpToDate    = "uptodate"    // a check by hand found nothing newer
	UpdateAvailable   = "available"   // newer, but this install can't replace itself: download it by hand
	UpdateFailed      = "failed"      // the download or the swap failed; Kanopa is unchanged
)

// UpdateEngine is the part that talks to the release source and replaces the program.
// main adapts the Wails updater to it.
type UpdateEngine interface {
	// Check returns the version of a newer stable release, or "" when there is none.
	Check(ctx context.Context) (version string, err error)
	// Download fetches the version Check found, verifies it against the release's checksum and
	// stages it. progress is told how many bytes of how many have come.
	Download(ctx context.Context, progress func(written, total int64)) error
	// Restart replaces the running program with the staged one and starts it again.
	Restart(ctx context.Context) error
}

// UpdateConfig is what main gives the UpdateService.
type UpdateConfig struct {
	Store   *settings.Store
	Engine  UpdateEngine
	Version string
	// SelfUpdate: this install can replace itself (Windows, in a folder it can write to).
	SelfUpdate bool
	// ReleasesURL is the page that lists the downloads.
	ReleasesURL string
	// Pending says how many entries have unapplied changes.
	Pending func() int
	// OpenURL opens an address in the person's browser.
	OpenURL func(url string) error
	// Interval is how often an automatic check repeats; zero uses a day.
	Interval time.Duration
	Log      *slog.Logger
}

// UpdateStatus is how updating stands.
type UpdateStatus struct {
	// Supported is false for a build that never checks (a local -dev build).
	Supported bool `json:"supported"`
	// Asked: the person has answered the question about checking by themselves.
	Asked bool `json:"asked"`
	// Auto: Kanopa checks at start and every day.
	Auto bool `json:"auto"`
	// SelfUpdate: this install can replace itself.
	SelfUpdate bool `json:"selfUpdate"`
	// State is one of the Update* constants.
	State string `json:"state"`
	// Version is the newer version, when there is one.
	Version string `json:"version"`
	// Percent is how much of the download has come, 0 to 100.
	Percent int `json:"percent"`
	// Current is the version that is running.
	Current string `json:"current"`
	// Failure says, in plain words, why the last update did not install.
	Failure string `json:"failure"`
}

// UpdateService checks for, downloads and installs new versions of Kanopa.
type UpdateService struct {
	cfg UpdateConfig

	mu      sync.Mutex
	state   string
	version string
	percent int
	failure string
	busy    bool
}

// NewUpdateService returns the service for cfg.
func NewUpdateService(cfg UpdateConfig) *UpdateService {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 24 * time.Hour
	}
	return &UpdateService{cfg: cfg, state: UpdateIdle}
}

// supported is false for a local build, which never checks: its version is not one a release can beat.
func (u *UpdateService) supported() bool {
	return u.cfg.Engine != nil && !strings.HasSuffix(u.cfg.Version, "-dev")
}

// Start checks now and then every interval, while the person has asked for it, until ctx ends.
func (u *UpdateService) Start(ctx context.Context) {
	if !u.supported() {
		return
	}
	go func() {
		if u.cfg.Store.Updates().Auto {
			u.run(ctx, false)
		}
		t := time.NewTicker(u.cfg.Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if u.cfg.Store.Updates().Auto {
					u.run(ctx, false)
				}
			}
		}
	}()
}

// UpdateStatus says how updating stands.
func (u *UpdateService) UpdateStatus() UpdateStatus {
	u.mu.Lock()
	defer u.mu.Unlock()
	prefs := u.cfg.Store.Updates()
	return UpdateStatus{
		Supported: u.supported(), Asked: prefs.Asked, Auto: prefs.Auto, SelfUpdate: u.cfg.SelfUpdate,
		State: u.state, Version: u.version, Percent: u.percent, Current: u.cfg.Version, Failure: u.failure,
	}
}

// SetAutoUpdate records the answer to "keep Kanopa up to date?". Saying yes checks at once.
func (u *UpdateService) SetAutoUpdate(on bool) (UpdateStatus, error) {
	if err := u.cfg.Store.SetUpdates(settings.Updates{Asked: true, Auto: on}); err != nil {
		u.cfg.Log.Warn("save update choice", "err", err)
		return u.UpdateStatus(), err
	}
	if on && u.supported() {
		go u.run(context.Background(), false)
	}
	return u.UpdateStatus(), nil
}

// CheckForUpdates checks now, whether or not automatic checks are on, and returns at once;
// poll UpdateStatus for the result.
func (u *UpdateService) CheckForUpdates() UpdateStatus {
	if u.supported() {
		go u.run(context.Background(), true)
		// Show "checking" at once rather than after the goroutine is scheduled.
		u.mu.Lock()
		if !u.busy && u.state != UpdateReady && u.state != UpdateDownloading {
			u.state, u.failure = UpdateChecking, ""
		}
		u.mu.Unlock()
	}
	return u.UpdateStatus()
}

// OpenReleasesPage opens the page that lists the downloads.
func (u *UpdateService) OpenReleasesPage() error {
	if u.cfg.OpenURL == nil || u.cfg.ReleasesURL == "" {
		return errors.New("Kanopa can't open the browser here.")
	}
	return u.cfg.OpenURL(u.cfg.ReleasesURL)
}

// RestartToUpdate replaces Kanopa with the downloaded version and starts it again. It refuses
// while changes are pending, so nothing the person has not applied is lost.
func (u *UpdateService) RestartToUpdate() error {
	u.mu.Lock()
	ready := u.state == UpdateReady
	u.mu.Unlock()
	if !ready {
		return errors.New("There is no update ready to install.")
	}
	if u.cfg.Pending != nil {
		if n := u.cfg.Pending(); n > 0 {
			return errors.New("Apply or discard your pending changes first, then restart to update.")
		}
	}
	if err := u.cfg.Engine.Restart(context.Background()); err != nil {
		u.cfg.Log.Warn("restart to update", "err", err)
		u.set(func() {
			u.state, u.failure = UpdateFailed, "Kanopa couldn't restart into the new version. It is unchanged."
		})
		return err
	}
	return nil
}

func (u *UpdateService) set(f func()) {
	u.mu.Lock()
	defer u.mu.Unlock()
	f()
}

// run is one check, and, when this install can replace itself, the download that follows.
// byHand: the person asked, so "up to date" and a failed check are said out loud.
func (u *UpdateService) run(ctx context.Context, byHand bool) {
	u.mu.Lock()
	if u.busy || u.state == UpdateReady || u.state == UpdateDownloading {
		u.mu.Unlock()
		return
	}
	u.busy = true
	u.state, u.failure, u.percent = UpdateChecking, "", 0
	u.mu.Unlock()
	defer u.set(func() { u.busy = false })

	version, err := u.cfg.Engine.Check(ctx)
	switch {
	case err != nil:
		u.cfg.Log.Info("update check failed", "err", err)
		u.set(func() {
			if byHand {
				u.state, u.failure = UpdateFailed, "Kanopa couldn't reach GitHub to look for a new version."
			} else {
				u.state = UpdateIdle // a missing network is not worth interrupting anyone for
			}
		})
		return
	case version == "":
		u.set(func() {
			u.state = UpdateIdle
			if byHand {
				u.state = UpdateUpToDate
			}
		})
		return
	}

	if !u.cfg.SelfUpdate {
		u.set(func() { u.state, u.version = UpdateAvailable, version })
		return
	}
	u.set(func() { u.state, u.version = UpdateDownloading, version })
	err = u.cfg.Engine.Download(ctx, func(written, total int64) {
		if total <= 0 {
			return
		}
		u.set(func() { u.percent = int(min(100, written*100/total)) })
	})
	if err != nil {
		u.cfg.Log.Warn("update download", "version", version, "err", err)
		u.set(func() {
			u.state = UpdateFailed
			u.failure = fmt.Sprintf("Kanopa %s didn't install, and Kanopa is unchanged (%s). It will try again at the next check.", version, u.cfg.Version)
		})
		return
	}
	u.cfg.Log.Info("update ready", "version", version)
	u.set(func() { u.state, u.percent = UpdateReady, 100 })
}
