//go:build !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// systemIsDark: macOS draws the native frame from the window's appearance, set when the window opens.
func systemIsDark() bool { return false }

// paintTitleBar: Wails 3.1 can't change a macOS window's appearance after it opens, so a theme chosen
// while Kanopa runs reaches the title bar the next time it starts.
func paintTitleBar(*application.WebviewWindow, bool) {}
