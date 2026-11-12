package services

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestAboutAndDiagnosticsNameOnlyTheBuild(t *testing.T) {
	a := NewAppService(AppConfig{Version: "0.1.0", Webview: func() string { return "WebView2 150.0" }, LogDir: `C:\Users\someone\Kanopa\logs`})
	ab := a.About()
	if ab.Name != "Kanopa" || ab.Version != "0.1.0" || ab.License != "MIT" || ab.Webview != "WebView2 150.0" || ab.System == "" || ab.Go == "" {
		t.Fatalf("got %+v", ab)
	}
	d := a.Diagnostics()
	for _, want := range []string{"Kanopa 0.1.0", "System: ", "Web engine: WebView2 150.0", "Go: go"} {
		if !strings.Contains(d, want) {
			t.Errorf("diagnostics should hold %q:\n%s", want, d)
		}
	}
	// A bug report carries versions, not where the person's files are.
	if strings.Contains(d, "someone") || strings.Contains(d, "logs") {
		t.Errorf("diagnostics must not name folders:\n%s", d)
	}
}

func TestOpenLogFolder(t *testing.T) {
	var opened string
	a := NewAppService(AppConfig{LogDir: "/logs", OpenPath: func(p string) error { opened = p; return nil }})
	if err := a.OpenLogFolder(); err != nil || opened != "/logs" {
		t.Fatalf("opened %q, err %v", opened, err)
	}
	failing := NewAppService(AppConfig{LogDir: "/logs", OpenPath: func(string) error { return errors.New("no file manager") }})
	if err := failing.OpenLogFolder(); err == nil || !strings.Contains(err.Error(), "/logs") {
		t.Fatalf("got %v", err)
	}
	if err := NewAppService(AppConfig{}).OpenLogFolder(); err == nil {
		t.Fatal("nothing to open")
	}
}

func TestOpenRepoOpensOnlyTheHomePage(t *testing.T) {
	var opened string
	a := NewAppService(AppConfig{OpenURL: func(u string) error { opened = u; return nil }})
	if err := a.OpenRepo(); err != nil || opened != "https://github.com/S0obi/kanopa" {
		t.Fatalf("opened %q, err %v", opened, err)
	}
	if err := NewAppService(AppConfig{}).OpenRepo(); err == nil {
		t.Fatal("nothing to open it with")
	}
}

func TestClientErrorsGoToTheLogShortened(t *testing.T) {
	var buf bytes.Buffer
	a := NewAppService(AppConfig{Log: slog.New(slog.NewTextHandler(&buf, nil))})
	a.LogClientError("TypeError: x is undefined", strings.Repeat("at render\n", 1000))
	out := buf.String()
	if !strings.Contains(out, "interface error") || !strings.Contains(out, "TypeError") {
		t.Fatalf("log: %s", out)
	}
	if len(out) > 9000 {
		t.Fatalf("a crash stack is clipped, got %d bytes", len(out))
	}
}
