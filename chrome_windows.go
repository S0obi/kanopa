//go:build windows

package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/w32"
)

// systemIsDark reports whether Windows is in dark mode.
func systemIsDark() bool { return w32.IsCurrentlyDarkMode() }

// paintTitleBar switches the native title bar between its light and dark look, while the app runs.
func paintTitleBar(win *application.WebviewWindow, dark bool) {
	application.InvokeAsync(func() {
		if w32.SupportsThemes() {
			w32.SetTheme(uintptr(win.NativeWindow()), dark)
		}
	})
}
