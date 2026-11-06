package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The built frontend (frontend/dist) is embedded into the binary.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := application.New(application.Options{
		Name:        "Tada",
		Description: "One big button, endless confetti",
		Services: []application.Service{
			application.NewService(&PartyService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Tada",
		Width:     1100,
		Height:    760,
		MinWidth:  720,
		MinHeight: 560,
		// Matches the dark theme background so the window doesn't flash white on start.
		BackgroundColour: application.NewRGB(18, 14, 30),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
