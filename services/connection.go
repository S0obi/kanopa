// Package services holds the Go services exposed to the frontend through Wails bindings.
package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/S0obi/kanopa/internal/connections"
	"github.com/S0obi/kanopa/internal/ldapx"
	"github.com/S0obi/kanopa/internal/secrets"
)

// ConnectionParams is the connection form as the frontend sends it.
type ConnectionParams struct {
	URL            string `json:"url"`
	Security       string `json:"security"` // ldaps | starttls | none
	Bind           string `json:"bind"`     // simple | anonymous
	BindDN         string `json:"bindDn"`
	Password       string `json:"password"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	VerifyCert     bool   `json:"verifyCert"`
	// ConnectionID, when editing a saved connection: an empty password then uses the saved one.
	ConnectionID string `json:"connectionId"`
}

// TestResult is the outcome of Test connection, worded for the UI.
type TestResult struct {
	OK             bool     `json:"ok"`
	Title          string   `json:"title"`
	Message        string   `json:"message"`
	Code           int      `json:"code"`
	ElapsedMs      int64    `json:"elapsedMs"`
	NamingContexts []string `json:"namingContexts"`
	BaseDN         string   `json:"baseDn"`
	Vendor         string   `json:"vendor"`
}

// ConnectionService saves, tests and opens LDAP connections.
type ConnectionService struct {
	log     *slog.Logger
	open    func(context.Context, ldapx.Params) (*ldapx.Session, error)
	store   *connections.Store
	secrets secrets.Store

	mu       sync.Mutex
	sessions map[string]*ldapx.Session // open connections by connection ID
}

// NewConnectionService returns a service over the given connections file and credential store.
func NewConnectionService(log *slog.Logger, store *connections.Store, sec secrets.Store) *ConnectionService {
	if log == nil {
		log = slog.Default()
	}
	return &ConnectionService{log: log, open: ldapx.Open, store: store, secrets: sec, sessions: map[string]*ldapx.Session{}}
}

// storeName is where passwords live on this OS, as the UI names it.
func storeName() string {
	if runtime.GOOS == "darwin" {
		return "macOS Keychain"
	}
	return "Windows Credential Manager"
}

func (p ConnectionParams) toLDAP() ldapx.Params {
	return ldapx.Params{
		URL:        p.URL,
		Security:   ldapx.Security(p.Security),
		Bind:       ldapx.BindMethod(p.Bind),
		BindDN:     p.BindDN,
		Password:   p.Password,
		Timeout:    time.Duration(p.TimeoutSeconds) * time.Second,
		VerifyCert: p.VerifyCert,
	}
}

// Test opens a connection, binds, reads the root DSE and closes it again.
func (s *ConnectionService) Test(ctx context.Context, p ConnectionParams) TestResult {
	start := time.Now()
	res := s.test(ctx, p)
	res.ElapsedMs = time.Since(start).Milliseconds()
	if res.OK {
		res.Message = successText(p, res)
	}
	s.log.Info("connection test", "url", strings.TrimSpace(p.URL), "security", p.Security, "bind", p.Bind,
		"ok", res.OK, "code", res.Code, "elapsed_ms", res.ElapsedMs)
	return res
}

func (s *ConnectionService) test(ctx context.Context, p ConnectionParams) TestResult {
	if p.Password == "" && p.ConnectionID != "" && p.Bind != string(ldapx.BindAnonymous) && s.secrets != nil {
		if pw, err := s.secrets.Get(p.ConnectionID); err == nil {
			p.Password = pw
		}
	}
	sess, err := s.open(ctx, p.toLDAP())
	if err != nil {
		return failure(err)
	}
	defer sess.Close()
	dse, err := sess.ReadRootDSE(ctx)
	if err != nil {
		return failure(err)
	}
	vendor := strings.TrimSpace(dse.VendorName + " " + dse.VendorVersion)
	return TestResult{OK: true, Title: "Connection works", NamingContexts: dse.NamingContexts, BaseDN: dse.BaseDN(), Vendor: vendor}
}

// FetchBaseDN connects with the form's settings and returns the server's base DN.
func (s *ConnectionService) FetchBaseDN(ctx context.Context, p ConnectionParams) TestResult {
	res := s.test(ctx, p)
	if res.OK && res.BaseDN == "" {
		res.OK = false
		res.Title = "No naming context."
		res.Message = "The server does not publish a naming context. Enter the base DN yourself."
	}
	if res.OK {
		res.Message = res.BaseDN
	}
	return res
}

func failure(err error) TestResult {
	var le *ldapx.Error
	if errors.As(err, &le) {
		return TestResult{Title: le.Title, Message: le.Text(), Code: le.Code}
	}
	// Validation errors from ldapx are already sentences.
	return TestResult{Title: "Check the connection settings.", Message: err.Error()}
}

func successText(p ConnectionParams, r TestResult) string {
	who := "Connected anonymously"
	if p.Bind != string(ldapx.BindAnonymous) {
		who = "Bound as " + strings.TrimSpace(p.BindDN)
	}
	sec := ldapx.Security(p.Security)
	if ep, err := ldapx.ParseURL(p.URL); err == nil {
		sec, _ = ldapx.SecurityFor(ep, sec)
	}
	msg := fmt.Sprintf("%s in %d ms over %s.", who, r.ElapsedMs, sec.Label())
	switch n := len(r.NamingContexts); n {
	case 0:
		msg += " The server offers no naming context."
	case 1:
		msg += " The server offers 1 naming context: " + r.NamingContexts[0] + "."
	default:
		msg += fmt.Sprintf(" The server offers %d naming contexts: %s.", n, strings.Join(r.NamingContexts, ", "))
	}
	return msg
}
