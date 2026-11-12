package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/S0obi/kanopa/internal/settings"
)

// Default window size when nothing was saved.
const (
	defaultWidth  = 1280
	defaultHeight = 800
	minWidth      = 960
	minHeight     = 640
)

// placeWindow decides where the window opens: where it was, when that is still on a screen, else
// the default size, centered. A saved window that no screen shows any more (a monitor was
// unplugged) or that is bigger than every screen would be lost, so it is not used.
func placeWindow(saved settings.Window, ok bool, screens []application.Rect) (w settings.Window, restored bool) {
	fallback := settings.Window{Width: defaultWidth, Height: defaultHeight}
	if !ok || !saved.Valid() || len(screens) == 0 {
		return fallback, false
	}
	saved.Width, saved.Height = max(saved.Width, minWidth), max(saved.Height, minHeight)
	cx, cy := saved.X+saved.Width/2, saved.Y+saved.Height/2
	for _, s := range screens {
		inside := cx >= s.X && cx < s.X+s.Width && cy >= s.Y && cy < s.Y+s.Height
		// The title bar has to be reachable: its top edge on this screen.
		reachable := saved.Y >= s.Y && saved.Y < s.Y+s.Height-40
		if inside && reachable && saved.Width <= s.Width && saved.Height <= s.Height {
			return saved, true
		}
	}
	return fallback, false
}

// fillsAScreen reports whether the bounds cover a whole screen (give or take the borders of a maximized
// window): those are the bounds of a maximized window, not a place worth going back to.
func fillsAScreen(b application.Rect, screens []application.Rect) bool {
	for _, s := range screens {
		if b.Width >= s.Width-16 && b.Height >= s.Height-48 {
			return true
		}
	}
	return false
}

// screenBounds lists the screens' bounds in device-independent pixels.
func screenBounds(app *application.App) []application.Rect {
	var out []application.Rect
	for _, s := range app.Screen.GetAll() {
		out = append(out, s.Bounds)
	}
	return out
}
