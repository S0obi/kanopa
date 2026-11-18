package services

import (
	"sync"
	"testing"
	"time"
)

type fakeClipboard struct {
	mu   sync.Mutex
	text string
}

func (c *fakeClipboard) get() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.text
}

func (c *fakeClipboard) set(t string) {
	c.mu.Lock()
	c.text = t
	c.mu.Unlock()
}

func (c *fakeClipboard) config() Clipboard {
	return Clipboard{
		Read:  func() (string, bool) { return c.get(), true },
		Write: func(t string) bool { c.set(t); return true },
	}
}

func TestCopySecret(t *testing.T) {
	t.Run("clears after the time when the clipboard still holds it", func(t *testing.T) {
		cb := &fakeClipboard{}
		a := NewAppService(AppConfig{Clipboard: cb.config()})
		if err := a.CopySecret("H7k#qR4m", 1); err != nil || cb.get() != "H7k#qR4m" {
			t.Fatalf("copy: %v, clipboard %q", err, cb.get())
		}
		time.Sleep(1300 * time.Millisecond)
		if cb.get() != "" {
			t.Fatalf("still on the clipboard: %q", cb.get())
		}
	})

	t.Run("leaves something else that was copied meanwhile", func(t *testing.T) {
		cb := &fakeClipboard{}
		a := NewAppService(AppConfig{Clipboard: cb.config()})
		_ = a.CopySecret("secret-one", 1)
		cb.set("something else")
		time.Sleep(1300 * time.Millisecond)
		if cb.get() != "something else" {
			t.Fatalf("overwrote the person's copy: %q", cb.get())
		}
	})

	t.Run("a second copy starts its own time", func(t *testing.T) {
		cb := &fakeClipboard{}
		a := NewAppService(AppConfig{Clipboard: cb.config()})
		_ = a.CopySecret("first", 1)
		time.Sleep(600 * time.Millisecond)
		_ = a.CopySecret("second", 1)
		time.Sleep(600 * time.Millisecond) // the first timer would have fired by now
		if cb.get() != "second" {
			t.Fatalf("cleared too early: %q", cb.get())
		}
		time.Sleep(700 * time.Millisecond)
		if cb.get() != "" {
			t.Fatalf("second not cleared: %q", cb.get())
		}
	})

	t.Run("ClearSecret on quit", func(t *testing.T) {
		cb := &fakeClipboard{}
		a := NewAppService(AppConfig{Clipboard: cb.config()})
		_ = a.CopySecret("on-quit", 60)
		a.ClearSecret()
		if cb.get() != "" {
			t.Fatalf("quit left it: %q", cb.get())
		}
		a.ClearSecret() // nothing to forget: no panic, no change
	})

	t.Run("refuses an empty secret and a missing clipboard", func(t *testing.T) {
		cb := &fakeClipboard{}
		if err := NewAppService(AppConfig{Clipboard: cb.config()}).CopySecret("", 5); err == nil {
			t.Fatal("empty text should be refused")
		}
		if err := NewAppService(AppConfig{}).CopySecret("x", 5); err == nil {
			t.Fatal("no clipboard should be refused")
		}
	})
}
