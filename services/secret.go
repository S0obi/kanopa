package services

import (
	"errors"
	"time"
)

// A secret copied to the clipboard is cleared again after a while, but only while the clipboard
// still holds it: if the person copied something else meanwhile, that is left alone. The timer
// lives here and not in the page, because a hidden window slows its timers down.

// DefaultSecretSeconds is how long a copied password stays on the clipboard.
const DefaultSecretSeconds = 60

// Clipboard is the system clipboard, as the service needs it.
type Clipboard struct {
	// Read returns the clipboard's text, and false when it holds none or cannot be read.
	Read func() (string, bool)
	// Write puts text on the clipboard, and reports whether it worked.
	Write func(text string) bool
}

// CopySecret puts text on the clipboard and clears it after seconds (60 when 0 or less, 300 at most),
// unless the clipboard holds something else by then. A later call takes over from an earlier one.
func (a *AppService) CopySecret(text string, seconds int) error {
	if a.cfg.Clipboard.Write == nil || text == "" {
		return errors.New("Kanopa can't reach the clipboard.")
	}
	if !a.cfg.Clipboard.Write(text) {
		return errors.New("Kanopa couldn't copy to the clipboard.")
	}
	if seconds <= 0 {
		seconds = DefaultSecretSeconds
	}
	seconds = min(seconds, 300)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.secretTimer != nil {
		a.secretTimer.Stop()
	}
	a.secret = text
	a.secretTimer = time.AfterFunc(time.Duration(seconds)*time.Second, a.ClearSecret)
	return nil
}

// ClearSecret clears the clipboard if it still holds the secret Kanopa copied, and forgets the secret.
// It is called when the timer runs out and when Kanopa quits.
func (a *AppService) ClearSecret() {
	a.mu.Lock()
	secret := a.secret
	a.secret = ""
	if a.secretTimer != nil {
		a.secretTimer.Stop()
		a.secretTimer = nil
	}
	a.mu.Unlock()
	if secret == "" || a.cfg.Clipboard.Read == nil || a.cfg.Clipboard.Write == nil {
		return
	}
	if now, ok := a.cfg.Clipboard.Read(); ok && now == secret {
		a.cfg.Clipboard.Write("")
	}
}
