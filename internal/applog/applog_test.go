package applog

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNeverWritesPasswords(t *testing.T) {
	dir := t.TempDir()
	var console bytes.Buffer
	log, closer, err := New(dir, &console)
	if err != nil {
		t.Fatal(err)
	}
	log.Info("bind", "url", "ldaps://ldap.example.org:636", "password", "s3cret", "bindPassword", "s3cret", "apiToken", "s3cret")
	closer.Close()

	file, err := os.ReadFile(filepath.Join(dir, "kanopa.log"))
	if err != nil {
		t.Fatal(err)
	}
	for name, out := range map[string]string{"file": string(file), "console": console.String()} {
		if strings.Contains(out, "s3cret") {
			t.Errorf("%s log contains a secret: %s", name, out)
		}
		if !strings.Contains(out, "ldaps://ldap.example.org:636") {
			t.Errorf("%s log lost a normal attribute: %s", name, out)
		}
	}
}
