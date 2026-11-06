package secrets

import (
	"errors"
	"os"
	"testing"
)

func exercise(t *testing.T, s Store, id string) {
	t.Helper()
	if _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get before Set: %v", err)
	}
	if err := s.Set(id, "s3cret"); err != nil {
		t.Fatal(err)
	}
	if pw, err := s.Get(id); err != nil || pw != "s3cret" {
		t.Fatalf("Get = %q, %v", pw, err)
	}
	if err := s.Delete(id); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(id); err != nil {
		t.Fatalf("deleting twice should be fine: %v", err)
	}
	if _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete: %v", err)
	}
}

func TestMemory(t *testing.T) { exercise(t, NewMemory(), "conn-1") }

// The real credential store, only when asked: KANOPA_TEST_KEYRING=1 go test ./internal/secrets
func TestKeyring(t *testing.T) {
	if os.Getenv("KANOPA_TEST_KEYRING") != "1" {
		t.Skip("set KANOPA_TEST_KEYRING=1 to write to the OS credential store")
	}
	exercise(t, Keyring{}, "kanopa-test-entry")
}
