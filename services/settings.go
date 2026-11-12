package services

import (
	"fmt"
	"log/slog"

	"github.com/S0obi/kanopa/internal/settings"
)

// SettingsService holds Kanopa's own preferences and keeps the window's frame in step with them.
type SettingsService struct {
	log   *slog.Logger
	store *settings.Store
	// chrome paints the native window (its background and title bar) for a resolved theme.
	chrome func(dark bool)
}

// NewSettingsService returns the service; chrome is what SetAppearance calls (main sets it).
func NewSettingsService(log *slog.Logger, store *settings.Store, chrome func(dark bool)) *SettingsService {
	return &SettingsService{log: log, store: store, chrome: chrome}
}

// Theme is the saved choice: "system", "light" (Clearing) or "dark" (Night forest).
func (s *SettingsService) Theme() string { return s.store.Theme() }

// SetTheme saves the choice. When it can't be saved the choice still holds until Kanopa closes,
// and the error says why it won't last.
func (s *SettingsService) SetTheme(choice string) error {
	if err := s.store.SetTheme(choice); err != nil {
		s.log.Warn("save theme", "err", err)
		return err
	}
	return nil
}

// SetAppearance tells the window which theme the page now shows ("light" or "dark"), after the
// choice was resolved against the operating system. It paints the native frame to match.
func (s *SettingsService) SetAppearance(resolved string) error {
	if resolved != settings.ThemeLight && resolved != settings.ThemeDark {
		return fmt.Errorf("Kanopa can't paint the window for %q.", resolved)
	}
	if s.chrome != nil {
		s.chrome(resolved == settings.ThemeDark)
	}
	return nil
}
