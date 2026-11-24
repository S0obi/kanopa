package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

func TestPickAssetTakesTheZipOnWindowsAndNeverTheSetup(t *testing.T) {
	assets := []github.ReleaseAsset{
		{Name: "Kanopa-0.3.0-macos-universal.dmg"},
		{Name: "Kanopa-0.3.0-windows-amd64-setup.exe"},
		{Name: "Kanopa-0.3.0-windows-amd64-portable.zip"},
		{Name: "SHA256SUMS"},
	}
	if got := pickAsset(updater.CheckRequest{Platform: "windows", Arch: "amd64"}, assets); got != 2 {
		t.Fatalf("windows picked %d, want the zip (2)", got)
	}
	if got := pickAsset(updater.CheckRequest{Platform: "darwin", Arch: "arm64"}, assets); got != 0 {
		t.Fatalf("darwin picked %d, want the dmg (0)", got)
	}
	if got := pickAsset(updater.CheckRequest{Platform: "windows", Arch: "arm64"}, assets); got != -1 {
		t.Fatalf("windows arm64 picked %d, want none", got)
	}
	if got := pickAsset(updater.CheckRequest{Platform: "linux", Arch: "amd64"}, assets); got != -1 {
		t.Fatalf("linux picked %d, want none", got)
	}
}

// releaseServer answers like api.github.com for one release.
func releaseServer(t *testing.T, tag string, sums string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/S0obi/kanopa/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		assets := []map[string]any{
			{"id": 1, "name": "Kanopa-" + tag + "-windows-amd64-setup.exe", "size": 10, "url": srv.URL + "/dl/setup"},
			{"id": 2, "name": "Kanopa-" + tag + "-windows-amd64-portable.zip", "size": 10, "url": srv.URL + "/dl/zip"},
		}
		if sums != "" {
			assets = append(assets, map[string]any{"id": 3, "name": "SHA256SUMS", "size": len(sums), "url": srv.URL + "/dl/sums"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v" + tag, "assets": assets})
	})
	mux.HandleFunc("/dl/sums", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(sums)) })
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestTheProviderOffersANewerReleaseWithItsChecksum(t *testing.T) {
	sum := sha256.Sum256([]byte("the zip"))
	hexSum := hex.EncodeToString(sum[:])
	sums := fmt.Sprintf("%s  Kanopa-0.3.0-windows-amd64-portable.zip\n%s  Kanopa-0.3.0-windows-amd64-setup.exe\n", hexSum, hexSum)
	srv := releaseServer(t, "0.3.0", sums)
	p, err := newUpdateProvider(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	rel, err := p.Check(context.Background(), updater.CheckRequest{CurrentVersion: "0.2.0", Platform: "windows", Arch: "amd64"})
	if err != nil || rel == nil {
		t.Fatalf("rel %v err %v", rel, err)
	}
	if rel.Version != "0.3.0" || rel.Artifact.Filename != "Kanopa-0.3.0-windows-amd64-portable.zip" {
		t.Fatalf("unexpected %+v", rel)
	}
	if rel.Verification == nil || hex.EncodeToString(rel.Verification.Digest) != hexSum {
		t.Fatalf("no checksum: %+v", rel.Verification)
	}
}

func TestTheProviderHasNothingForTheVersionAlreadyRunning(t *testing.T) {
	srv := releaseServer(t, "0.2.0", "x  y\n")
	p, _ := newUpdateProvider(srv.URL)
	rel, err := p.Check(context.Background(), updater.CheckRequest{CurrentVersion: "0.2.0", Platform: "windows", Arch: "amd64"})
	if rel != nil || err != nil {
		t.Fatalf("rel %v err %v", rel, err)
	}
}

func TestAReleaseWithoutAChecksumIsRefused(t *testing.T) {
	for name, sums := range map[string]string{
		"no SHA256SUMS file":          "",
		"the file is not in the list": "00ff  something-else.zip\n",
	} {
		srv := releaseServer(t, "0.3.0", sums)
		p, _ := newUpdateProvider(srv.URL)
		rel, err := p.Check(context.Background(), updater.CheckRequest{CurrentVersion: "0.2.0", Platform: "windows", Arch: "amd64"})
		if err == nil || rel != nil {
			t.Errorf("%s: an unchecked release was offered: %v, %v", name, rel, err)
		}
	}
}
