package services

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/S0obi/kanopa/internal/settings"
)

type fakeEngine struct {
	mu        sync.Mutex
	version   string
	checkErr  error
	dlErr     error
	checks    int
	downloads int
	restarts  int
	release   chan struct{} // when set, Download waits for it
}

func (f *fakeEngine) Check(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checks++
	return f.version, f.checkErr
}

func (f *fakeEngine) Download(_ context.Context, progress func(w, t int64)) error {
	f.mu.Lock()
	f.downloads++
	gate := f.release
	err := f.dlErr
	f.mu.Unlock()
	progress(50, 200)
	if gate != nil {
		<-gate
	}
	progress(200, 200)
	return err
}

func (f *fakeEngine) Restart(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarts++
	return nil
}

func (f *fakeEngine) count() (checks, downloads, restarts int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.checks, f.downloads, f.restarts
}

func updateStore(t *testing.T) *settings.Store {
	t.Helper()
	s, err := settings.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newUpdates(t *testing.T, eng *fakeEngine, mutate func(*UpdateConfig)) (*UpdateService, *settings.Store) {
	t.Helper()
	store := updateStore(t)
	cfg := UpdateConfig{Store: store, Engine: eng, Version: "0.2.0", SelfUpdate: true,
		ReleasesURL: "https://example.org/releases", Pending: func() int { return 0 }}
	if mutate != nil {
		mutate(&cfg)
	}
	return NewUpdateService(cfg), store
}

func waitUpdate(t *testing.T, u *UpdateService, want string) UpdateStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if st := u.UpdateStatus(); st.State == want {
			return st
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("never reached %q, stuck at %+v", want, u.UpdateStatus())
	return UpdateStatus{}
}

// waitChecks waits until the engine has been asked n times and the service is idle again.
func waitChecks(t *testing.T, eng *fakeEngine, u *UpdateService, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if checks, _, _ := eng.count(); checks >= n && u.UpdateStatus().State != UpdateChecking {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the engine was not asked %d times: %+v", n, u.UpdateStatus())
}

func TestNothingIsContactedUntilThePersonSaysYes(t *testing.T) {
	eng := &fakeEngine{version: "0.3.0"}
	u, _ := newUpdates(t, eng, func(c *UpdateConfig) { c.Interval = 10 * time.Millisecond })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	u.Start(ctx)
	time.Sleep(60 * time.Millisecond)
	if checks, _, _ := eng.count(); checks != 0 {
		t.Fatalf("checked %d times without being asked", checks)
	}
	if st := u.UpdateStatus(); st.Asked || st.Auto || st.State != UpdateIdle {
		t.Fatalf("unexpected %+v", st)
	}
}

func TestSayingYesChecksDownloadsAndGetsReady(t *testing.T) {
	eng := &fakeEngine{version: "0.3.0"}
	u, store := newUpdates(t, eng, nil)
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	st := waitUpdate(t, u, UpdateReady)
	if st.Version != "0.3.0" || st.Percent != 100 || !st.Asked || !st.Auto || st.Failure != "" {
		t.Fatalf("unexpected %+v", st)
	}
	if got := store.Updates(); !got.Asked || !got.Auto {
		t.Fatalf("the answer was not saved: %+v", got)
	}
}

func TestSayingNotNowIsRememberedAndChecksNothing(t *testing.T) {
	eng := &fakeEngine{version: "0.3.0"}
	u, store := newUpdates(t, eng, nil)
	if _, err := u.SetAutoUpdate(false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if checks, _, _ := eng.count(); checks != 0 {
		t.Fatalf("checked %d times after Not now", checks)
	}
	if got := store.Updates(); !got.Asked || got.Auto {
		t.Fatalf("unexpected %+v", got)
	}
}

func TestACheckByHandWorksWithAutomaticChecksOffAndSaysUpToDate(t *testing.T) {
	eng := &fakeEngine{}
	u, _ := newUpdates(t, eng, nil)
	u.CheckForUpdates()
	st := waitUpdate(t, u, UpdateUpToDate)
	if st.Auto {
		t.Fatalf("a check by hand turned automatic checks on: %+v", st)
	}
	if _, downloads, _ := eng.count(); downloads != 0 {
		t.Fatal("downloaded with nothing newer")
	}
}

func TestAnAutomaticCheckWithNothingNewerStaysQuiet(t *testing.T) {
	eng := &fakeEngine{}
	u, _ := newUpdates(t, eng, nil)
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	waitChecks(t, eng, u, 1)
	if st := u.UpdateStatus(); st.State != UpdateIdle {
		t.Fatalf("an automatic check with nothing newer says something: %+v", st)
	}
}

func TestAMissingNetworkIsQuietForAnAutomaticCheckAndSaidForOneByHand(t *testing.T) {
	eng := &fakeEngine{checkErr: errors.New("no route to host")}
	u, _ := newUpdates(t, eng, nil)
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	waitChecks(t, eng, u, 1)
	if st := u.UpdateStatus(); st.State != UpdateIdle {
		t.Fatalf("a missing network interrupts: %+v", st)
	}

	u.CheckForUpdates()
	st := waitUpdate(t, u, UpdateFailed)
	if st.Failure == "" {
		t.Fatalf("a failed check by hand says nothing: %+v", st)
	}
}

func TestAnInstallThatCannotReplaceItselfIsOnlyToldAboutTheNewVersion(t *testing.T) {
	eng := &fakeEngine{version: "0.3.0"}
	u, _ := newUpdates(t, eng, func(c *UpdateConfig) { c.SelfUpdate = false })
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	st := waitUpdate(t, u, UpdateAvailable)
	if st.Version != "0.3.0" || st.SelfUpdate {
		t.Fatalf("unexpected %+v", st)
	}
	if _, downloads, _ := eng.count(); downloads != 0 {
		t.Fatal("downloaded on an install that cannot replace itself")
	}
}

func TestAFailedDownloadLeavesKanopaUnchangedAndSaysSo(t *testing.T) {
	eng := &fakeEngine{version: "0.3.0", dlErr: errors.New("updater: digest mismatch")}
	u, _ := newUpdates(t, eng, nil)
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	st := waitUpdate(t, u, UpdateFailed)
	if st.Failure == "" || st.Current != "0.2.0" {
		t.Fatalf("unexpected %+v", st)
	}
	// The next check tries again.
	eng.mu.Lock()
	eng.dlErr = nil
	eng.mu.Unlock()
	u.CheckForUpdates()
	waitUpdate(t, u, UpdateReady)
}

func TestRestartIsRefusedWhileChangesArePending(t *testing.T) {
	eng := &fakeEngine{version: "0.3.0"}
	pending := 2
	u, _ := newUpdates(t, eng, func(c *UpdateConfig) { c.Pending = func() int { return pending } })
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	waitUpdate(t, u, UpdateReady)

	if err := u.RestartToUpdate(); err == nil {
		t.Fatal("restarted with pending changes")
	}
	if _, _, restarts := eng.count(); restarts != 0 {
		t.Fatalf("restarts = %d", restarts)
	}
	pending = 0
	if err := u.RestartToUpdate(); err != nil {
		t.Fatal(err)
	}
	if _, _, restarts := eng.count(); restarts != 1 {
		t.Fatalf("restarts = %d", restarts)
	}
}

func TestRestartNeedsADownloadedUpdate(t *testing.T) {
	u, _ := newUpdates(t, &fakeEngine{}, nil)
	if err := u.RestartToUpdate(); err == nil {
		t.Fatal("restarted with nothing downloaded")
	}
}

func TestALocalBuildNeverChecks(t *testing.T) {
	eng := &fakeEngine{version: "9.9.9"}
	u, _ := newUpdates(t, eng, func(c *UpdateConfig) { c.Version = "0.1.0-dev" })
	u.CheckForUpdates()
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if checks, _, _ := eng.count(); checks != 0 {
		t.Fatalf("a -dev build checked %d times", checks)
	}
	if st := u.UpdateStatus(); st.Supported {
		t.Fatalf("a -dev build says it is supported: %+v", st)
	}
}

func TestTheDownloadReportsItsProgressAndOnlyOneRunsAtATime(t *testing.T) {
	gate := make(chan struct{})
	eng := &fakeEngine{version: "0.3.0", release: gate}
	u, _ := newUpdates(t, eng, nil)
	if _, err := u.SetAutoUpdate(true); err != nil {
		t.Fatal(err)
	}
	st := waitUpdate(t, u, UpdateDownloading)
	deadline := time.Now().Add(2 * time.Second)
	for st.Percent != 25 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
		st = u.UpdateStatus()
	}
	if st.Percent != 25 {
		t.Fatalf("percent = %d, want 25", st.Percent)
	}
	u.CheckForUpdates() // a second request while one runs does nothing
	time.Sleep(20 * time.Millisecond)
	close(gate)
	waitUpdate(t, u, UpdateReady)
	if checks, downloads, _ := eng.count(); checks != 1 || downloads != 1 {
		t.Fatalf("checks = %d, downloads = %d", checks, downloads)
	}
}

func TestTheReleasesPageOpens(t *testing.T) {
	var opened string
	u, _ := newUpdates(t, &fakeEngine{}, func(c *UpdateConfig) {
		c.OpenURL = func(url string) error { opened = url; return nil }
	})
	if err := u.OpenReleasesPage(); err != nil || opened != "https://example.org/releases" {
		t.Fatalf("opened %q, err %v", opened, err)
	}
}
