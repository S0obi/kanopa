//go:build darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// setupMenu gives macOS the menu it expects: without an Edit menu, Cmd+C, Cmd+V and Cmd+A do nothing in a
// webview, and without the app menu there is no Cmd+Q, Cmd+H or About.
func setupMenu(app *application.App) {
	menu := application.NewMenu()
	menu.AddRole(application.AppMenu)
	menu.AddRole(application.EditMenu)
	menu.AddRole(application.WindowMenu)
	app.Menu.SetApplicationMenu(menu)
}
