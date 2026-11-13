package main

import (
	"embed"
	"fmt"
	"log"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/S0obi/kanopa/internal/applog"
	"github.com/S0obi/kanopa/internal/connections"
	"github.com/S0obi/kanopa/internal/secrets"
	"github.com/S0obi/kanopa/internal/settings"
	"github.com/S0obi/kanopa/services"
)

// The built frontend (frontend/dist) is embedded into the binary.
//
//go:embed all:frontend/dist
var assets embed.FS

// version is 0.1.0-dev for a local build. A release build sets it with -ldflags "-X main.version=…" (task build VERSION=0.1.0).
var version = "0.1.0-dev"

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

// run starts Kanopa and returns when the last window closes; deferred cleanup always runs.
func run() error {
	logger := slog.Default()
	logDir, _ := applog.Dir()
	if logDir != "" {
		if l, closer, err := applog.New(logDir, os.Stderr); err == nil {
			logger = l
			defer closer.Close()
		}
	}
	logger.Info("kanopa starting", "version", version)

	store := openConnections(logger)
	connSvc := services.NewConnectionService(logger, store, secrets.Keyring{})
	dirSvc := services.NewDirectoryService(logger, connSvc)
	changeSvc := services.NewChangeService(logger, connSvc)
	prefs := openSettings(logger)
	var win *application.WebviewWindow
	settingsSvc := services.NewSettingsService(logger, prefs, func(dark bool) {
		if win == nil {
			return
		}
		win.SetBackgroundColour(surfaceColour(dark))
		paintTitleBar(win, dark)
	})
	var app *application.App
	appSvc := services.NewAppService(services.AppConfig{
		Close: func() {
			if win != nil {
				win.Close()
			}
		},
		Version:  version,
		Webview:  func() string { return webviewText(app) },
		LogDir:   logDir,
		OpenPath: func(path string) error { return app.Env.OpenFileManager(path, false) },
		OpenURL:  func(url string) error { return app.Browser.OpenURL(url) },
		Log:      logger,
	})

	app = application.New(application.Options{
		Name:        "Kanopa",
		Description: "A calm, exact LDAP client",
		Services: []application.Service{
			application.NewService(connSvc),
			application.NewService(dirSvc),
			application.NewService(changeSvc),
			application.NewService(appSvc),
			application.NewService(settingsSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		// A panic in a service call becomes a failed call (Wails recovers it); this puts it in the log with its stack.
		PanicHandler: func(d *application.PanicDetails) {
			logger.Error("panic", "error", fmt.Sprint(d.Error), "stack", d.StackTrace)
		},
		// Quitting (Cmd+Q on macOS) waits for the person's answer when changes are pending, like closing the window.
		ShouldQuit: func() bool {
			if appSvc.ShouldBlockClose() {
				app.Event.Emit(services.EventCloseRequested)
				return false
			}
			return true
		},
		// A second launch brings the open window forward instead of starting another.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "app.kanopa.desktop",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if win != nil {
					win.Restore()
					win.Focus()
				}
			},
		},
	})
	setupMenu(app)

	// The window opens once the screens are known (Wails reads them when it starts), so a saved place can be checked.
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		saved, hadSaved := prefs.Window()
		screens := screenBounds(app)
		place, restored := placeWindow(saved, hadSaved, screens)
		opts := application.WebviewWindowOptions{
			Title:     "Kanopa",
			Width:     place.Width,
			Height:    place.Height,
			MinWidth:  minWidth,
			MinHeight: minHeight,
			// The Kanopa surface color of the theme, so the window doesn't flash the wrong one on start.
			BackgroundColour: surfaceColour(startsDark(prefs.Theme())),
			URL:              "/",
			Windows:          application.WindowsWindow{Theme: windowsTheme(prefs.Theme())},
			Mac:              application.MacWindow{Appearance: macAppearance(prefs.Theme())},
		}
		if restored {
			opts.InitialPosition, opts.X, opts.Y = application.WindowXY, place.X, place.Y
		}
		win = app.Window.NewWithOptions(opts)
		if restored && place.Maximized {
			// Not StartState: Wails moves the window to its position after maximizing it, which undoes it.
			var once sync.Once
			win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) {
				once.Do(func() { win.Maximise() }) //nolint:misspell // Wails spells it this way
			})
		}
		// The window is followed as it moves, so closing doesn't depend on asking a window that is going away.
		var remembered settings.Window
		var wasMaximized bool
		if hadSaved {
			remembered, wasMaximized = saved, saved.Maximized
		}
		follow := func() {
			if win.IsMinimised() { //nolint:misspell // Wails spells it this way
				return
			}
			// Windows sends the resize before the window reports being maximized: those bounds are the screen's.
			if b := win.Bounds(); !fillsAScreen(b, screens) {
				remembered = settings.Window{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}
			}
		}
		moved := func(*application.WindowEvent) {
			// While maximized (or about to be), the bounds are the screen's: keep the earlier ones.
			if !wasMaximized && !win.IsMaximised() { //nolint:misspell // Wails spells it this way
				follow()
			}
		}
		win.OnWindowEvent(events.Common.WindowDidMove, moved)
		win.OnWindowEvent(events.Common.WindowDidResize, moved)
		win.OnWindowEvent(events.Common.WindowMaximise, func(*application.WindowEvent) { wasMaximized = true })
		win.OnWindowEvent(events.Common.WindowUnMaximise, func(*application.WindowEvent) {
			if !win.IsMaximised() { //nolint:misspell // Wails spells it this way
				wasMaximized = false
				follow()
			}
		})
		// Closing with unapplied changes waits for the person's answer; otherwise the window is remembered.
		win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
			if appSvc.ShouldBlockClose() {
				e.Cancel()
				app.Event.Emit(services.EventCloseRequested)
				return
			}
			if !remembered.Valid() {
				remembered = settings.Window{X: place.X, Y: place.Y, Width: place.Width, Height: place.Height}
				if b := win.Bounds(); b.Width > 0 {
					remembered = settings.Window{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}
				}
			}
			// What the window is at this moment decides whether it is maximized; the followed bounds are where it was.
			out := remembered
			if out.Maximized = win.IsMaximised(); !out.Maximized { //nolint:misspell // Wails spells it this way
				follow()
				out = remembered
				out.Maximized = false
			}
			if err := prefs.SetWindow(out); err != nil {
				logger.Warn("remember window", "err", err)
			}
		})
	})

	if err := app.Run(); err != nil {
		logger.Error("kanopa stopped", "err", err)
		return err
	}
	return nil
}

// openConnections opens the saved connections. When that fails the app still starts, with none, and says why.
func openConnections(logger *slog.Logger) *connections.Store {
	path, err := connections.DefaultPath()
	if err == nil {
		var store *connections.Store
		if store, err = connections.Open(path); err == nil {
			return store
		}
	}
	logger.Error("open connections", "path", path, "err", err)
	return connections.Unavailable(path, err)
}

// openSettings opens Kanopa's preferences. When that fails the app still starts, with the defaults.
func openSettings(logger *slog.Logger) *settings.Store {
	path, err := settings.DefaultPath()
	if err == nil {
		var store *settings.Store
		if store, err = settings.Open(path); err == nil {
			if n := store.Notice(); n != "" {
				logger.Warn(n)
			}
			return store
		}
	}
	logger.Error("open settings", "path", path, "err", err)
	return settings.Unavailable(path, err)
}

// startsDark reports whether the window opens in Night forest: chosen, or System on a dark OS.
func startsDark(choice string) bool {
	return choice == settings.ThemeDark || (choice == settings.ThemeSystem && systemIsDark())
}

// surfaceColour is the --surface token of Clearing or Night forest (frontend/src/theme/tokens.json).
func surfaceColour(dark bool) application.RGBA {
	if dark {
		return application.NewRGB(19, 26, 21)
	}
	return application.NewRGB(243, 246, 240)
}

// windowsTheme is the title-bar theme the window opens with.
func windowsTheme(choice string) application.Theme {
	switch choice {
	case settings.ThemeDark:
		return application.Dark
	case settings.ThemeLight:
		return application.Light
	}
	return application.SystemDefault
}

// macAppearance is the appearance the window opens with.
func macAppearance(choice string) application.MacAppearanceType {
	switch choice {
	case settings.ThemeDark:
		return application.NSAppearanceNameDarkAqua
	case settings.ThemeLight:
		return application.NSAppearanceNameAqua
	}
	return application.DefaultAppearance
}

// webviewText names the web engine the window runs on, when the platform says (WebView2's version on Windows).
func webviewText(app *application.App) string {
	if app == nil {
		return ""
	}
	var out []string
	for k, v := range app.Env.Info().PlatformInfo {
		if strings.Contains(strings.ToLower(k), "webview") {
			out = append(out, fmt.Sprintf("%s %v", k, v))
		}
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}
