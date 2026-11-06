package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/S0obi/kanopa/internal/connections"
	"github.com/S0obi/kanopa/internal/ldapx"
)

// SavedConnection is a saved connection as the UI shows it. It never carries the password.
type SavedConnection struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	URL            string `json:"url"`
	Security       string `json:"security"`
	BaseDN         string `json:"baseDn"`
	Bind           string `json:"bind"`
	BindDN         string `json:"bindDn"`
	SavePassword   bool   `json:"savePassword"`
	HasPassword    bool   `json:"hasPassword"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	PageSize       int    `json:"pageSize"`
	Referrals      string `json:"referrals"`
	ReadOnly       bool   `json:"readOnly"`
	VerifyCert     bool   `json:"verifyCert"`
	PlainConsent   bool   `json:"plainConsent"`
	LastUsed       string `json:"lastUsed"` // RFC 3339, empty when never used
	LastError      string `json:"lastError"`
}

// ListResult is the saved connections, plus a one-time notice about the file.
type ListResult struct {
	Connections []SavedConnection `json:"connections"`
	Notice      string            `json:"notice"`
}

// SaveRequest is the connection form. An empty ID creates a connection.
// An empty Password keeps the saved one.
type SaveRequest struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	URL            string `json:"url"`
	Security       string `json:"security"`
	BaseDN         string `json:"baseDn"`
	Bind           string `json:"bind"`
	BindDN         string `json:"bindDn"`
	Password       string `json:"password"`
	SavePassword   bool   `json:"savePassword"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	PageSize       int    `json:"pageSize"`
	Referrals      string `json:"referrals"`
	ReadOnly       bool   `json:"readOnly"`
	VerifyCert     bool   `json:"verifyCert"`
}

// Why a connection attempt stopped, so the UI can offer the right next step.
const (
	ReasonNeedsPassword = "needsPassword"
	ReasonBadPassword   = "badPassword"
	ReasonNeedsConsent  = "needsConsent"
	ReasonUnreachable   = "unreachable"
	ReasonOther         = "other"
)

// ConnectResult is the outcome of Connect.
type ConnectResult struct {
	OK      bool         `json:"ok"`
	Title   string       `json:"title"`
	Message string       `json:"message"`
	Code    int          `json:"code"`
	Reason  string       `json:"reason"`
	Session *SessionInfo `json:"session"`
}

// SessionInfo describes an open connection and the server behind it.
type SessionInfo struct {
	ConnectionID   string   `json:"connectionId"`
	Name           string   `json:"name"`
	URL            string   `json:"url"`
	Security       string   `json:"security"` // LDAPS | StartTLS | an unencrypted link
	BoundAs        string   `json:"boundAs"`  // empty for anonymous
	BaseDN         string   `json:"baseDn"`
	Vendor         string   `json:"vendor"`
	NamingContexts []string `json:"namingContexts"`
	LDAPVersions   []string `json:"ldapVersions"`
	Controls       int      `json:"controls"`
	Extensions     int      `json:"extensions"`
	ElapsedMs      int64    `json:"elapsedMs"`
	ReadOnly       bool     `json:"readOnly"`
}

func (s *ConnectionService) view(c connections.Connection) SavedConnection {
	v := SavedConnection{
		ID: c.ID, Name: c.Name, URL: c.URL, Security: c.Security, BaseDN: c.BaseDN, Bind: c.Bind, BindDN: c.BindDN,
		SavePassword: c.SavePassword, TimeoutSeconds: c.TimeoutSeconds, PageSize: c.PageSize, Referrals: c.Referrals,
		ReadOnly: c.ReadOnly, VerifyCert: c.VerifyCert, PlainConsent: c.PlainConsent, LastError: c.LastError,
	}
	if c.LastUsed != nil {
		v.LastUsed = c.LastUsed.Format(time.RFC3339)
	}
	if c.Bind == string(ldapx.BindSimple) && c.SavePassword {
		_, err := s.secrets.Get(c.ID)
		v.HasPassword = err == nil
	}
	return v
}

// List returns the saved connections in order.
func (s *ConnectionService) List() ListResult {
	out := ListResult{Connections: []SavedConnection{}, Notice: s.store.Notice()}
	for _, c := range s.store.List() {
		out.Connections = append(out.Connections, s.view(c))
	}
	return out
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func validate(r SaveRequest) (connections.Connection, error) {
	c := connections.Connection{
		ID: r.ID, Name: strings.TrimSpace(r.Name), URL: strings.TrimSpace(r.URL), BaseDN: strings.TrimSpace(r.BaseDN),
		Bind: r.Bind, BindDN: strings.TrimSpace(r.BindDN), SavePassword: r.SavePassword,
		TimeoutSeconds: r.TimeoutSeconds, PageSize: r.PageSize, Referrals: r.Referrals, ReadOnly: r.ReadOnly, VerifyCert: r.VerifyCert,
	}
	if c.Name == "" {
		return c, errors.New("Enter a name for this connection.")
	}
	ep, err := ldapx.ParseURL(c.URL)
	if err != nil {
		return c, err
	}
	sec, err := ldapx.SecurityFor(ep, ldapx.Security(r.Security))
	if err != nil {
		return c, err
	}
	c.URL, c.Security = ep.URL(), string(sec)
	switch ldapx.BindMethod(c.Bind) {
	case ldapx.BindAnonymous:
		c.BindDN, c.SavePassword = "", false
	case ldapx.BindSimple:
		if c.BindDN == "" {
			return c, errors.New("Enter a bind DN, or choose Anonymous.")
		}
	default:
		return c, errors.New("Choose Simple bind or Anonymous.")
	}
	if c.TimeoutSeconds < 1 || c.TimeoutSeconds > 300 {
		c.TimeoutSeconds = 10
	}
	if c.PageSize < 1 {
		c.PageSize = 500
	}
	if c.Referrals != "ignore" {
		c.Referrals = "show"
	}
	return c, nil
}

// Save creates or updates a connection. The password goes to the OS credential store, never to the file.
func (s *ConnectionService) Save(r SaveRequest) (SavedConnection, error) {
	c, err := validate(r)
	if err != nil {
		return SavedConnection{}, err
	}
	if c.ID == "" {
		c.ID = newID()
	} else {
		old, err := s.store.Get(c.ID)
		if err != nil {
			return SavedConnection{}, err
		}
		c.LastUsed = old.LastUsed
		// Consent covers this host without encryption; a new host or port asks again.
		c.PlainConsent = old.PlainConsent && old.URL == c.URL
	}
	switch {
	case !c.SavePassword:
		if err := s.secrets.Delete(c.ID); err != nil {
			return SavedConnection{}, s.secretErr(err)
		}
	case r.Password != "":
		if err := s.secrets.Set(c.ID, r.Password); err != nil {
			return SavedConnection{}, s.secretErr(err)
		}
	}
	if err := s.store.Put(c, ""); err != nil {
		return SavedConnection{}, err
	}
	s.log.Info("connection saved", "id", c.ID, "url", c.URL, "security", c.Security, "bind", c.Bind)
	return s.view(c), nil
}

func (s *ConnectionService) secretErr(err error) error {
	s.log.Error("credential store", "err", err)
	return fmt.Errorf("Kanopa could not reach the %s: %v", storeName(), err)
}

// Duplicate copies a connection, its saved password included, right after the original.
func (s *ConnectionService) Duplicate(id string) (SavedConnection, error) {
	c, err := s.store.Get(id)
	if err != nil {
		return SavedConnection{}, err
	}
	copied := c
	copied.ID, copied.Name, copied.LastUsed, copied.LastError = newID(), c.Name+" (copy)", nil, ""
	if pw, err := s.secrets.Get(id); err == nil {
		if err := s.secrets.Set(copied.ID, pw); err != nil {
			return SavedConnection{}, s.secretErr(err)
		}
	}
	if err := s.store.Put(copied, id); err != nil {
		return SavedConnection{}, err
	}
	return s.view(copied), nil
}

// Delete removes a connection and its saved password. Nothing changes on the server.
func (s *ConnectionService) Delete(id string) error {
	if _, err := s.store.Get(id); err != nil {
		return err
	}
	s.Disconnect(id)
	if err := s.secrets.Delete(id); err != nil {
		return s.secretErr(err)
	}
	if err := s.store.Delete(id); err != nil {
		return err
	}
	s.log.Info("connection deleted", "id", id)
	return nil
}

// AllowUnencrypted remembers that the person accepts this connection without encryption.
func (s *ConnectionService) AllowUnencrypted(id string) error {
	_, err := s.store.Update(id, func(c *connections.Connection) { c.PlainConsent = true })
	return err
}

// Connect opens a saved connection. An empty password uses the saved one; a password
// given here is saved when savePassword is true.
func (s *ConnectionService) Connect(ctx context.Context, id, password string, savePassword bool) ConnectResult {
	c, err := s.store.Get(id)
	if err != nil {
		return ConnectResult{Title: "Connection not found.", Message: err.Error(), Reason: ReasonOther}
	}
	if c.Security == string(ldapx.SecurityNone) && !c.PlainConsent {
		return ConnectResult{Title: "Connect without encryption?", Reason: ReasonNeedsConsent,
			Message: fmt.Sprintf("%s uses neither LDAPS nor StartTLS.", c.URL)}
	}
	pw := password
	if c.Bind == string(ldapx.BindSimple) && pw == "" {
		saved, err := s.secrets.Get(id)
		if err != nil {
			return ConnectResult{Title: "Password needed.", Reason: ReasonNeedsPassword,
				Message: fmt.Sprintf("Enter the password for %s.", c.BindDN)}
		}
		pw = saved
	}

	start := time.Now()
	sess, err := s.open(ctx, ldapx.Params{URL: c.URL, Security: ldapx.Security(c.Security), Bind: ldapx.BindMethod(c.Bind),
		BindDN: c.BindDN, Password: pw, Timeout: time.Duration(c.TimeoutSeconds) * time.Second, VerifyCert: c.VerifyCert})
	var dse *ldapx.RootDSE
	if err == nil {
		if dse, err = sess.ReadRootDSE(ctx); err != nil {
			sess.Close()
		}
	}
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		res := ConnectResult{Reason: ReasonOther}
		var le *ldapx.Error
		if errors.As(err, &le) {
			res.Title, res.Message, res.Code = le.Title, le.Text(), le.Code
			switch {
			case le.Code == 49:
				res.Reason = ReasonBadPassword
			case le.Code == ldapx.CodeServerDown || le.Code == ldapx.CodeTimeout:
				res.Reason = ReasonUnreachable
			}
		} else {
			res.Title, res.Message = "Check the connection settings.", err.Error()
		}
		_, _ = s.store.Update(id, func(x *connections.Connection) { x.LastError = res.Message })
		s.log.Info("connect failed", "id", id, "code", res.Code, "elapsed_ms", elapsed)
		return res
	}

	if password != "" && savePassword {
		if err := s.secrets.Set(id, password); err == nil {
			c.SavePassword = true
		} else {
			s.log.Error("credential store", "err", err)
		}
	}
	now := time.Now()
	c, _ = s.store.Update(id, func(x *connections.Connection) {
		x.LastUsed, x.LastError, x.SavePassword = &now, "", c.SavePassword
	})
	s.mu.Lock()
	if old := s.sessions[id]; old != nil {
		old.Close()
	}
	s.sessions[id] = sess
	s.mu.Unlock()

	info := &SessionInfo{
		ConnectionID: id, Name: c.Name, URL: sess.Endpoint.URL(), Security: sess.Security.Label(), BoundAs: sess.BindDN,
		BaseDN: c.BaseDN, Vendor: strings.TrimSpace(dse.VendorName + " " + dse.VendorVersion),
		NamingContexts: nonNil(dse.NamingContexts), LDAPVersions: nonNil(dse.LDAPVersions),
		Controls: len(dse.SupportedControls), Extensions: len(dse.SupportedExts), ElapsedMs: elapsed, ReadOnly: c.ReadOnly,
	}
	if info.BaseDN == "" {
		info.BaseDN = dse.BaseDN()
	}
	s.log.Info("connected", "id", id, "url", info.URL, "security", c.Security, "elapsed_ms", elapsed)
	return ConnectResult{OK: true, Title: "Connected.", Code: 0, Session: info,
		Message: fmt.Sprintf("Bound to %s in %d ms over %s.", sess.Endpoint.HostPort(), elapsed, sess.Security.Label())}
}

// Disconnect closes an open connection. Closing one that is not open is fine.
func (s *ConnectionService) Disconnect(id string) {
	s.mu.Lock()
	sess := s.sessions[id]
	delete(s.sessions, id)
	s.mu.Unlock()
	if sess != nil {
		sess.Close()
		s.log.Info("disconnected", "id", id)
	}
}

// ServiceShutdown closes every open connection when Kanopa quits (Wails service hook).
func (s *ConnectionService) ServiceShutdown() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, sess := range s.sessions {
		sess.Close()
		delete(s.sessions, id)
	}
	return nil
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}
