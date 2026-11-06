package services

import (
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/go-ldap/ldap/v3"

	"github.com/S0obi/kanopa/internal/connections"
	"github.com/S0obi/kanopa/internal/secrets"
)

func ldapErr49() error { return ldap.NewError(49, errors.New("")) }

// newTestService uses a connections file in a temp dir and an in-memory credential store.
func newTestService(t testing.TB) *ConnectionService {
	t.Helper()
	s, _ := newTestServiceWith(t)
	return s
}

func newTestServiceWith(t testing.TB) (*ConnectionService, *secrets.Memory) {
	t.Helper()
	store, err := connections.Open(filepath.Join(t.TempDir(), "connections.json"))
	if err != nil {
		t.Fatal(err)
	}
	mem := secrets.NewMemory()
	svc := NewConnectionService(slog.New(slog.NewTextHandler(io.Discard, nil)), store, mem)
	t.Cleanup(func() { _ = svc.ServiceShutdown() })
	return svc, mem
}
