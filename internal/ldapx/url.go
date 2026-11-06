// Package ldapx wraps go-ldap with the connection rules and error wording Kanopa uses.
package ldapx

import (
	"errors"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// Security is how the connection is protected.
type Security string

const (
	SecurityLDAPS    Security = "ldaps"
	SecurityStartTLS Security = "starttls"
	SecurityNone     Security = "none"
)

// Label is the security as the UI names it.
func (s Security) Label() string {
	switch s {
	case SecurityLDAPS:
		return "LDAPS"
	case SecurityStartTLS:
		return "StartTLS"
	default:
		return "an unencrypted link"
	}
}

// Endpoint is a parsed LDAP URL.
type Endpoint struct {
	Scheme string // "ldap" or "ldaps"
	Host   string
	Port   int
}

// HostPort returns host:port, bracketing IPv6 hosts.
func (e Endpoint) HostPort() string { return net.JoinHostPort(e.Host, strconv.Itoa(e.Port)) }

// URL returns the canonical URL with an explicit port.
func (e Endpoint) URL() string { return e.Scheme + "://" + e.HostPort() }

// IsLocal reports whether the host is this computer.
func (e Endpoint) IsLocal() bool {
	h := strings.ToLower(e.Host)
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// DefaultPort is 636 for ldaps and 389 for ldap.
func DefaultPort(scheme string) int {
	if scheme == "ldaps" {
		return 636
	}
	return 389
}

// ErrInvalidURL is returned for anything that is not ldap[s]://host[:port].
var ErrInvalidURL = errors.New("Enter an LDAP URL such as ldaps://ldap.example.org:636.")

var urlRE = regexp.MustCompile(`^(?i)(ldaps?)://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?/?$`)

// ParseURL parses ldap://host[:port] or ldaps://host[:port].
func ParseURL(raw string) (Endpoint, error) {
	m := urlRE.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return Endpoint{}, ErrInvalidURL
	}
	scheme := strings.ToLower(m[1])
	host := strings.TrimSuffix(strings.TrimPrefix(m[2], "["), "]")
	port := DefaultPort(scheme)
	if m[3] != "" {
		p, err := strconv.Atoi(m[3])
		if err != nil || p < 1 || p > 65535 {
			return Endpoint{}, ErrInvalidURL
		}
		port = p
	}
	return Endpoint{Scheme: scheme, Host: host, Port: port}, nil
}

// SecurityFor checks that the chosen security matches the URL scheme.
// ldaps:// always means LDAPS; ldap:// means StartTLS or none.
func SecurityFor(ep Endpoint, s Security) (Security, error) {
	switch {
	case ep.Scheme == "ldaps":
		return SecurityLDAPS, nil
	case s == SecurityStartTLS || s == SecurityNone:
		return s, nil
	case s == SecurityLDAPS:
		return "", errors.New("LDAPS needs an ldaps:// URL. Change the URL, or choose StartTLS.")
	default:
		return "", errors.New("Choose LDAPS, StartTLS or None.")
	}
}
