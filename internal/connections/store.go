// Package connections keeps the saved connections in a JSON file on this computer.
// Passwords never go in it; they live in the OS credential store (package secrets).
package connections

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// Version is the file format this build writes.
const Version = 1

// Connection is one saved directory. Field names are the file's format: change them only with a migration.
type Connection struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	URL            string     `json:"url"`
	Security       string     `json:"security"` // ldaps | starttls | none
	BaseDN         string     `json:"baseDn"`
	Bind           string     `json:"bind"` // simple | anonymous
	BindDN         string     `json:"bindDn"`
	SavePassword   bool       `json:"savePassword"`
	TimeoutSeconds int        `json:"timeoutSeconds"`
	PageSize       int        `json:"pageSize"`
	Referrals      string     `json:"referrals"` // show | ignore
	ReadOnly       bool       `json:"readOnly"`
	VerifyCert     bool       `json:"verifyCert"`
	PlainConsent   bool       `json:"plainConsent"` // the person agreed to connect without encryption
	LastUsed       *time.Time `json:"lastUsed"`
	LastError      string     `json:"lastError"`
}

type file struct {
	Version     int          `json:"version"`
	Connections []Connection `json:"connections"`
}

// ErrNotFound is returned for an unknown connection ID.
var ErrNotFound = errors.New("This connection no longer exists. It may have been deleted in another window.")

// Store is the connections file. Safe for concurrent use.
type Store struct {
	path  string
	mu    sync.Mutex
	conns []Connection
	// Notice is set when the file could not be read as is; the UI shows it once.
	notice string
	// readOnly is set when the file comes from a newer Kanopa: we never overwrite it.
	readOnly bool
}

// DefaultPath is <user config dir>/Kanopa/connections.json.
func DefaultPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "Kanopa", "connections.json"), nil
}

// Open reads the file at path. A missing file is an empty list. A file that is not
// valid JSON is moved aside, so the app still starts, and Notice says where it went.
func Open(path string) (*Store, error) {
	s := &Store{path: path}
	data, err := os.ReadFile(path) //nolint:gosec // G304: Kanopa's own settings file, from os.UserConfigDir()
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		aside := fmt.Sprintf("%s.unreadable-%s", path, time.Now().Format("20060102-150405"))
		if rerr := os.Rename(path, aside); rerr != nil {
			return nil, fmt.Errorf("the connections file %s is damaged and couldn't be moved aside: %w", path, rerr)
		}
		s.notice = fmt.Sprintf("Kanopa couldn't read your saved connections, so it started with none. The damaged file is kept as %s.", aside)
		return s, nil
	}
	if f.Version > Version {
		s.readOnly = true
		s.notice = "Your connections were saved by a newer Kanopa. They are shown, but changes are not saved until you update Kanopa."
	}
	s.conns = migrate(f)
	return s, nil
}

// Unavailable is a store that could not be opened: it lists nothing, saves nothing, and says why once.
func Unavailable(path string, err error) *Store {
	return &Store{path: path, readOnly: true,
		notice: fmt.Sprintf("Kanopa couldn't open your saved connections (%v). Check the permissions of %s, then restart Kanopa.", err, path)}
}

// migrate brings older files up to Version. Version 0 (no version field) is the same shape as 1.
func migrate(f file) []Connection {
	out := make([]Connection, 0, len(f.Connections))
	for _, c := range f.Connections {
		if c.TimeoutSeconds <= 0 {
			c.TimeoutSeconds = 10
		}
		if c.PageSize <= 0 {
			c.PageSize = 500
		}
		if c.Referrals == "" || c.Referrals == "follow" {
			c.Referrals = "show"
		}
		out = append(out, c)
	}
	return out
}

// Notice returns, then clears, the message about how the file was read.
func (s *Store) Notice() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.notice
	s.notice = ""
	return n
}

// List returns the connections in their saved order.
func (s *Store) List() []Connection {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.conns)
}

// Get returns one connection.
func (s *Store) Get(id string) (Connection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.index(id)
	if i < 0 {
		return Connection{}, ErrNotFound
	}
	return s.conns[i], nil
}

// Put adds the connection, or replaces the one with the same ID, and saves the file.
// A new connection goes after `after` when given (Duplicate), else at the end.
func (s *Store) Put(c Connection, after string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := slices.Clone(s.conns)
	if i := s.indexIn(next, c.ID); i >= 0 {
		next[i] = c
	} else if j := s.indexIn(next, after); j >= 0 {
		next = slices.Insert(next, j+1, c)
	} else {
		next = append(next, c)
	}
	return s.commit(next)
}

// Update applies fn to one connection and saves.
func (s *Store) Update(id string, fn func(*Connection)) (Connection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.index(id)
	if i < 0 {
		return Connection{}, ErrNotFound
	}
	next := slices.Clone(s.conns)
	fn(&next[i])
	return next[i], s.commit(next)
}

// Delete removes one connection and saves.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.index(id)
	if i < 0 {
		return ErrNotFound
	}
	return s.commit(slices.Delete(slices.Clone(s.conns), i, i+1))
}

func (s *Store) index(id string) int { return s.indexIn(s.conns, id) }

func (s *Store) indexIn(list []Connection, id string) int {
	if id == "" {
		return -1
	}
	return slices.IndexFunc(list, func(c Connection) bool { return c.ID == id })
}

// commit writes next to disk (temp file + rename, so a crash never leaves half a file), then keeps it.
func (s *Store) commit(next []Connection) error {
	if s.readOnly {
		return errors.New("Your connections were saved by a newer Kanopa, so this one can't change them. Update Kanopa, then try again.")
	}
	data, err := json.MarshalIndent(file{Version: Version, Connections: next}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("Kanopa couldn't create %s: %w", filepath.Dir(s.path), err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".connections-*.json")
	if err != nil {
		return fmt.Errorf("Kanopa couldn't save your connections: %w", err)
	}
	_, werr := tmp.Write(append(data, '\n'))
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("Kanopa couldn't save your connections: %w", errors.Join(werr, cerr))
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("Kanopa couldn't save your connections: %w", err)
	}
	s.conns = next
	return nil
}
