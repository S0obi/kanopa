package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/S0obi/kanopa/internal/settings"
)

var twoScreens = []application.Rect{{X: 0, Y: 0, Width: 1920, Height: 1080}, {X: 1920, Y: 0, Width: 1920, Height: 1080}}

func TestPlaceWindowRestoresWhereItWas(t *testing.T) {
	saved := settings.Window{X: 2100, Y: 120, Width: 1400, Height: 900, Maximized: true}
	got, ok := placeWindow(saved, true, twoScreens)
	if !ok || got != saved {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
}

func TestPlaceWindowFallsBackWhenTheMonitorIsGone(t *testing.T) {
	saved := settings.Window{X: 2100, Y: 120, Width: 1400, Height: 900}
	got, ok := placeWindow(saved, true, twoScreens[:1])
	if ok || got.Width != defaultWidth || got.Height != defaultHeight || got.X != 0 {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
}

func TestPlaceWindowRefusesWhatCantBeUsed(t *testing.T) {
	for name, tc := range map[string]struct {
		w  settings.Window
		ok bool
	}{
		"nothing saved":        {settings.Window{}, false},
		"zero size":            {settings.Window{X: 10, Y: 10}, true},
		"bigger than a screen": {settings.Window{X: 0, Y: 0, Width: 5000, Height: 3000}, true},
		"title bar off screen": {settings.Window{X: 100, Y: 1070, Width: 1200, Height: 800}, true},
	} {
		if _, restored := placeWindow(tc.w, tc.ok, twoScreens); restored {
			t.Errorf("%s: should not be restored", name)
		}
	}
	// A window smaller than the minimum is opened at the minimum, not refused.
	got, ok := placeWindow(settings.Window{X: 50, Y: 50, Width: 300, Height: 300}, true, twoScreens)
	if !ok || got.Width != minWidth || got.Height != minHeight {
		t.Errorf("got %+v ok=%v", got, ok)
	}
}

func TestMaximizedWindowKeepsItsEarlierBounds(t *testing.T) {
	before := settings.Window{X: 200, Y: 100, Width: 1300, Height: 850}
	got := windowToSave(application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}, true, before, true)
	if !got.Maximized || got.Width != 1300 || got.X != 200 {
		t.Fatalf("got %+v", got)
	}
	// With nothing before, the maximized bounds are all there is.
	got = windowToSave(application.Rect{Width: 1920, Height: 1040}, true, settings.Window{}, false)
	if !got.Maximized || got.Width != 1920 {
		t.Fatalf("got %+v", got)
	}
	// Not maximized: where it is now.
	got = windowToSave(application.Rect{X: 5, Y: 6, Width: 1000, Height: 700}, false, before, true)
	if got.Maximized || got.X != 5 || got.Width != 1000 {
		t.Fatalf("got %+v", got)
	}
}
