// Package secrets keeps bind passwords in the OS credential store:
// the macOS Keychain or the Windows Credential Manager.
package secrets

import (
	"errors"
	"sync"

	"github.com/zalando/go-keyring"
)

// Service is the name the entries carry in the credential store.
const Service = "Kanopa"

// ErrNotFound means no password is saved for that connection.
var ErrNotFound = errors.New("no saved password")

// Store saves one password per connection ID.
type Store interface {
	Get(id string) (string, error)
	Set(id, password string) error
	Delete(id string) error
}

// Keyring is the OS credential store. Entries are "Kanopa" / <connection id>.
type Keyring struct{}

func (Keyring) Get(id string) (string, error) {
	pw, err := keyring.Get(Service, id)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return pw, err
}

func (Keyring) Set(id, password string) error { return keyring.Set(Service, id, password) }

// Delete removes the entry; a missing entry is not an error.
func (Keyring) Delete(id string) error {
	err := keyring.Delete(Service, id)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// Memory is an in-process store for tests.
type Memory struct {
	mu sync.Mutex
	m  map[string]string
}

func NewMemory() *Memory { return &Memory{m: map[string]string{}} }

func (s *Memory) Get(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pw, ok := s.m[id]
	if !ok {
		return "", ErrNotFound
	}
	return pw, nil
}

func (s *Memory) Set(id, password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[id] = password
	return nil
}

func (s *Memory) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
	return nil
}

// Len reports how many passwords are held (tests).
func (s *Memory) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}
