package main

import (
	"embed"
	"log"
	"log/slog"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/S0obi/kanopa/internal/applog"
	"github.com/S0obi/kanopa/internal/connections"
	"github.com/S0obi/kanopa/internal/secrets"
	"github.com/S0obi/kanopa/services"
)

// The built frontend (frontend/dist) is embedded into the binary.
//
//go:embed all:frontend/dist
var assets embed.FS

// version is set at build time with -ldflags "-X main.version=…".
var version = "0.0.1-dev"

func main() {
	logger := slog.Default()
	if dir, err := applog.Dir(); err == nil {
		if l, closer, err := applog.New(dir, os.Stderr); err == nil {
			logger = l
			defer closer.Close()
		}
	}
	logger.Info("kanopa starting", "version", version)

	store := openConnections(logger)

	app := application.New(application.Options{
		Name:        "Kanopa",
		Description: "A calm, exact LDAP client",
		Services: []application.Service{
			application.NewService(services.NewConnectionService(logger, store, secrets.Keyring{})),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Kanopa",
		Width:     1280,
		Height:    800,
		MinWidth:  960,
		MinHeight: 640,
		// The Kanopa surface colour, so the window doesn't flash white on start.
		BackgroundColour: application.NewRGB(243, 246, 240),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
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
