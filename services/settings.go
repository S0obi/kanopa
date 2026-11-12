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

// RecentSearch is a search that was run on a connection: where, how deep, and the filter.
// Never its results.
type RecentSearch struct {
	Base   string   `json:"base"`
	Scope  string   `json:"scope"`
	Filter string   `json:"filter"`
	Attrs  []string `json:"attrs"`
}

// RecentSearches returns the last searches run on a connection, newest first.
func (s *SettingsService) RecentSearches(connectionID string) []RecentSearch {
	out := []RecentSearch{}
	for _, r := range s.store.Recent(connectionID) {
		out = append(out, RecentSearch{Base: r.Base, Scope: r.Scope, Filter: r.Filter, Attrs: nonNil(r.Attrs)})
	}
	return out
}

// AddRecentSearch remembers a search at the top of the connection's list. The filter is kept on
// this computer only, and never written to the log.
func (s *SettingsService) AddRecentSearch(connectionID string, r RecentSearch) error {
	return s.store.AddRecent(connectionID, settings.Recent{Base: r.Base, Scope: r.Scope, Filter: r.Filter, Attrs: nonNil(r.Attrs)})
}

// ClearRecentSearches forgets a connection's recent searches.
func (s *SettingsService) ClearRecentSearches(connectionID string) error {
	return s.store.ClearRecent(connectionID)
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
