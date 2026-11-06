package ldapx

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// BindMethod is how Kanopa authenticates.
type BindMethod string

const (
	BindSimple    BindMethod = "simple"
	BindAnonymous BindMethod = "anonymous"
)

// DefaultTimeout applies when Params.Timeout is zero.
const DefaultTimeout = 10 * time.Second

// Params is everything needed to open and bind a connection.
type Params struct {
	URL        string
	Security   Security
	Bind       BindMethod
	BindDN     string
	Password   string
	Timeout    time.Duration
	VerifyCert bool
}

// Session is an open, bound connection.
type Session struct {
	Conn     *ldap.Conn
	Endpoint Endpoint
	Security Security
	Bind     BindMethod
	BindDN   string
	Timeout  time.Duration
}

// Close releases the connection.
func (s *Session) Close() error {
	if s == nil || s.Conn == nil {
		return nil
	}
	return s.Conn.Close()
}

// Open dials, upgrades with StartTLS when asked, and binds.
// Every failure comes back as an *Error.
func Open(ctx context.Context, p Params) (*Session, error) {
	ep, err := ParseURL(p.URL)
	if err != nil {
		return nil, err
	}
	sec, err := SecurityFor(ep, p.Security)
	if err != nil {
		return nil, err
	}
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	bind := p.Bind
	if bind == "" {
		bind = BindSimple
	}
	bindDN := strings.TrimSpace(p.BindDN)
	if bind == BindAnonymous {
		bindDN = ""
	}
	op := Op{Endpoint: ep, Security: sec, BindDN: bindDN, Timeout: timeout}

	// The deadline covers the whole open: dial, TLS, StartTLS and bind.
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	deadline, _ := ctx.Deadline()

	tlsCfg := &tls.Config{
		ServerName:         ep.Host,
		InsecureSkipVerify: !p.VerifyCert, //nolint:gosec // the person chose this for a test server
		MinVersion:         tls.VersionTLS12,
	}
	dialer := &net.Dialer{Timeout: timeout, Deadline: deadline}

	op.Stage = StageDial
	conn, err := ldap.DialURL(ep.URL(), ldap.DialWithDialer(dialer), ldap.DialWithTLSConfig(tlsCfg))
	if err != nil {
		return nil, Classify(err, op)
	}
	conn.SetTimeout(time.Until(deadline))

	// Close the connection if the caller gives up, so blocked reads return.
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	fail := func(err error, stage Stage) (*Session, error) {
		conn.Close()
		if ctx.Err() != nil && !errors.Is(err, context.Canceled) {
			err = errors.Join(context.DeadlineExceeded, err)
		}
		op.Stage = stage
		return nil, Classify(err, op)
	}

	if sec == SecurityStartTLS {
		if err := conn.StartTLS(tlsCfg); err != nil {
			return fail(err, StageStartTLS)
		}
	}
	if bind == BindSimple {
		if err := conn.Bind(bindDN, p.Password); err != nil {
			return fail(err, StageBind)
		}
	} else if err := conn.UnauthenticatedBind(""); err != nil {
		// An explicit anonymous bind proves the server answers, and that it accepts anonymous access.
		return fail(err, StageBind)
	}
	if ctx.Err() != nil {
		return fail(ctx.Err(), StageBind)
	}
	conn.SetTimeout(timeout)
	return &Session{Conn: conn, Endpoint: ep, Security: sec, Bind: bind, BindDN: bindDN, Timeout: timeout}, nil
}

// RootDSE is the server's self-description.
type RootDSE struct {
	NamingContexts    []string
	DefaultContext    string
	VendorName        string
	VendorVersion     string
	SubschemaSubentry string
	SupportedControls []string
	SupportedExts     []string
	LDAPVersions      []string
}

// ReadRootDSE reads the root DSE of the server.
func (s *Session) ReadRootDSE(ctx context.Context) (*RootDSE, error) {
	op := Op{Endpoint: s.Endpoint, Security: s.Security, BindDN: s.BindDN, Timeout: s.Timeout, Stage: StageRead}
	req := ldap.NewSearchRequest("", ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, int(s.Timeout/time.Second), false,
		"(objectClass=*)",
		[]string{"namingContexts", "defaultNamingContext", "vendorName", "vendorVersion", "subschemaSubentry",
			"supportedControl", "supportedExtension", "supportedLDAPVersion"}, nil)
	res, err := searchCtx(ctx, s.Conn, req)
	if err != nil {
		return nil, Classify(err, op)
	}
	if len(res.Entries) == 0 {
		return &RootDSE{}, nil
	}
	e := res.Entries[0]
	return &RootDSE{
		NamingContexts:    e.GetAttributeValues("namingContexts"),
		DefaultContext:    e.GetAttributeValue("defaultNamingContext"),
		VendorName:        e.GetAttributeValue("vendorName"),
		VendorVersion:     e.GetAttributeValue("vendorVersion"),
		SubschemaSubentry: e.GetAttributeValue("subschemaSubentry"),
		SupportedControls: e.GetAttributeValues("supportedControl"),
		SupportedExts:     e.GetAttributeValues("supportedExtension"),
		LDAPVersions:      e.GetAttributeValues("supportedLDAPVersion"),
	}, nil
}

// BaseDN is the context Kanopa opens when none is configured:
// the server's default naming context, else its first one.
func (r *RootDSE) BaseDN() string {
	if r.DefaultContext != "" {
		return r.DefaultContext
	}
	if len(r.NamingContexts) > 0 {
		return r.NamingContexts[0]
	}
	return ""
}

func searchCtx(ctx context.Context, c *ldap.Conn, req *ldap.SearchRequest) (*ldap.SearchResult, error) {
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	res, err := c.Search(req)
	if err != nil && ctx.Err() != nil {
		return nil, errors.Join(ctx.Err(), err)
	}
	return res, err
}
