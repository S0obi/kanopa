package services

import "sync"

// EventCloseRequested is emitted when the person closes the window while changes are pending.
// The frontend asks them, then calls AppService.CloseAnyway.
const EventCloseRequested = "kanopa:close-requested"

// AppService guards the window against closing with changes that were never applied.
type AppService struct {
	mu      sync.Mutex
	pending int
	closing bool
	close   func() // closes the main window; set by main
}

// NewAppService returns the guard; close is what CloseAnyway calls.
func NewAppService(closeWindow func()) *AppService { return &AppService{close: closeWindow} }

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
	f := a.close
	a.mu.Unlock()
	if f != nil {
		f()
	}
}
