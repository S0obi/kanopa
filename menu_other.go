//go:build !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// setupMenu: Windows and Linux windows have no menu bar; Kanopa's own gear menu is in the interface.
func setupMenu(*application.App) {}
