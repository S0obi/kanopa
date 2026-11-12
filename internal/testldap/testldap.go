//go:build integration

// Package testldap starts Kanopa's OpenLDAP fixture (test/ldap) for integration tests.
// It needs a Docker daemon; on Windows, run scripts/docker-wsl.ps1 and set
// DOCKER_HOST=tcp://localhost:2375 (the test:it task does both).
package testldap

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Fixture accounts, as seeded by test/ldap/seedgen and the Dockerfile.
const (
	BaseDN         = "dc=example,dc=org"
	AdminDN        = "cn=admin,dc=example,dc=org"
	AdminPassword  = "kanopa-admin"
	ReaderDN       = "uid=svc-kanopa,ou=services,dc=example,dc=org"
	ReaderPassword = "kanopa-reader"
	PersonPassword = "kanopa-person"
)

// Server is a running fixture.
type Server struct {
	Host      string
	LDAPPort  int
	LDAPSPort int
	container testcontainers.Container
}

// LDAPURL is ldap://host:port (plain and StartTLS).
func (s *Server) LDAPURL() string { return fmt.Sprintf("ldap://%s:%d", s.Host, s.LDAPPort) }

// LDAPSURL is ldaps://host:port.
func (s *Server) LDAPSURL() string { return fmt.Sprintf("ldaps://%s:%d", s.Host, s.LDAPSPort) }

// Stop stops the container (to test a server going away) without removing it.
func (s *Server) Stop(ctx context.Context) error {
	timeout := 2 * time.Second
	return s.container.Stop(ctx, &timeout)
}

// Start starts the server again after Stop. Ports may change.
func (s *Server) Start(ctx context.Context) error {
	if err := s.container.Start(ctx); err != nil {
		return err
	}
	return s.readPorts(ctx)
}

func (s *Server) readPorts(ctx context.Context) error {
	host, err := s.container.Host(ctx)
	if err != nil {
		return err
	}
	p389, err := s.container.MappedPort(ctx, "389/tcp")
	if err != nil {
		return err
	}
	p636, err := s.container.MappedPort(ctx, "636/tcp")
	if err != nil {
		return err
	}
	s.Host, s.LDAPPort, s.LDAPSPort = host, int(p389.Num()), int(p636.Num())
	return nil
}

// ProfileEnv names the environment variable that picks the fixture's profile: "large" adds ou=archive (10,000
// people) and cn=everyone (5,000 members); it needs test/ldap/seed-large.ldif from `task ldap:seed-large`.
const ProfileEnv = "KANOPA_LDAP_PROFILE"

// Large reports whether the fixture is the large profile.
func Large() bool { return os.Getenv(ProfileEnv) == "large" }

func imageTag() string {
	if Large() {
		return "it-large"
	}
	return "it"
}

func buildArgs() map[string]*string {
	if !Large() {
		return nil
	}
	large := "large"
	return map[string]*string{"PROFILE": &large}
}

func contextDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "test", "ldap")
}

var (
	shared     *Server
	sharedErr  error
	sharedOnce sync.Once
)

// Shared returns one fixture for the whole test binary. Tests must not write to it.
func Shared(t testing.TB) *Server {
	t.Helper()
	sharedOnce.Do(func() { shared, sharedErr = start(context.Background()) })
	if sharedErr != nil {
		t.Fatalf("start the LDAP fixture: %v", sharedErr)
	}
	return shared
}

// New starts a private fixture, removed when the test ends. Use it to write or stop the server.
func New(t testing.TB) *Server {
	t.Helper()
	s, err := start(context.Background())
	if err != nil {
		t.Fatalf("start the LDAP fixture: %v", err)
	}
	t.Cleanup(func() { _ = s.container.Terminate(context.Background()) })
	return s
}

func start(ctx context.Context) (*Server, error) {
	req := testcontainers.ContainerRequest{
		FromDockerfile: testcontainers.FromDockerfile{
			Context:   contextDir(),
			Repo:      "kanopa-test-ldap",
			Tag:       imageTag(),
			KeepImage: true,
			BuildArgs: buildArgs(),
		},
		ExposedPorts: []string{"389/tcp", "636/tcp"},
		WaitingFor: wait.ForAll(
			wait.ForListeningPort("389/tcp"),
			wait.ForListeningPort("636/tcp"),
		).WithDeadline(60 * time.Second),
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: req, Started: true})
	if err != nil {
		return nil, err
	}
	s := &Server{container: c}
	if err := s.readPorts(ctx); err != nil {
		_ = c.Terminate(ctx)
		return nil, err
	}
	return s, nil
}
