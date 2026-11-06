//go:build integration

package ldapx_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/S0obi/kanopa/internal/ldapx"
	"github.com/S0obi/kanopa/internal/testldap"
)

func open(t *testing.T, p ldapx.Params) (*ldapx.Session, *ldapx.Error) {
	t.Helper()
	if p.Timeout == 0 {
		p.Timeout = 5 * time.Second
	}
	s, err := ldapx.Open(context.Background(), p)
	if err != nil {
		var le *ldapx.Error
		if !errors.As(err, &le) {
			t.Fatalf("want *ldapx.Error, got %T: %v", err, err)
		}
		return nil, le
	}
	t.Cleanup(func() { s.Close() })
	return s, nil
}

func TestBindSucceedsOverEverySecurity(t *testing.T) {
	srv := testldap.Shared(t)
	for _, c := range []struct {
		name string
		url  string
		sec  ldapx.Security
	}{
		{"LDAPS", srv.LDAPSURL(), ldapx.SecurityLDAPS},
		{"StartTLS", srv.LDAPURL(), ldapx.SecurityStartTLS},
		{"plain", srv.LDAPURL(), ldapx.SecurityNone},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, le := open(t, ldapx.Params{URL: c.url, Security: c.sec, Bind: ldapx.BindSimple,
				BindDN: testldap.AdminDN, Password: testldap.AdminPassword})
			if le != nil {
				t.Fatalf("bind failed: %s", le.Text())
			}
			dse, err := s.ReadRootDSE(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Contains(dse.NamingContexts, testldap.BaseDN) || dse.BaseDN() != testldap.BaseDN {
				t.Fatalf("naming contexts = %v", dse.NamingContexts)
			}
		})
	}
}

func TestAnonymousAndReaderBinds(t *testing.T) {
	srv := testldap.Shared(t)
	if _, le := open(t, ldapx.Params{URL: srv.LDAPURL(), Security: ldapx.SecurityNone, Bind: ldapx.BindAnonymous}); le != nil {
		t.Fatalf("anonymous: %s", le.Text())
	}
	if _, le := open(t, ldapx.Params{URL: srv.LDAPSURL(), Security: ldapx.SecurityLDAPS, Bind: ldapx.BindSimple,
		BindDN: testldap.ReaderDN, Password: testldap.ReaderPassword}); le != nil {
		t.Fatalf("reader: %s", le.Text())
	}
}

func TestWrongPasswordIs49(t *testing.T) {
	srv := testldap.Shared(t)
	_, le := open(t, ldapx.Params{URL: srv.LDAPSURL(), Security: ldapx.SecurityLDAPS, Bind: ldapx.BindSimple,
		BindDN: testldap.AdminDN, Password: "wrong"})
	if le == nil || le.Code != 49 {
		t.Fatalf("want 49, got %+v", le)
	}
	if !strings.Contains(le.Text(), testldap.AdminDN) || !strings.HasSuffix(le.Text(), "Invalid credentials (49)") {
		t.Fatalf("text = %q", le.Text())
	}
}

func TestUntrustedCertificateFailsOnlyWhenVerifying(t *testing.T) {
	srv := testldap.Shared(t)
	for _, c := range []struct {
		url string
		sec ldapx.Security
	}{{srv.LDAPSURL(), ldapx.SecurityLDAPS}, {srv.LDAPURL(), ldapx.SecurityStartTLS}} {
		_, le := open(t, ldapx.Params{URL: c.url, Security: c.sec, Bind: ldapx.BindAnonymous, VerifyCert: true})
		if le == nil || le.Code != ldapx.CodeConnectError || !strings.Contains(le.Text(), "unknown authority") {
			t.Fatalf("%s with verification: want -11 unknown authority, got %+v", c.sec, le)
		}
		if _, le := open(t, ldapx.Params{URL: c.url, Security: c.sec, Bind: ldapx.BindAnonymous}); le != nil {
			t.Fatalf("%s without verification: %s", c.sec, le.Text())
		}
	}
}

func TestLDAPSOnThePlainPort(t *testing.T) {
	srv := testldap.Shared(t)
	url := fmt.Sprintf("ldaps://%s:%d", srv.Host, srv.LDAPPort)
	_, le := open(t, ldapx.Params{URL: url, Security: ldapx.SecurityLDAPS, Bind: ldapx.BindAnonymous})
	if le == nil {
		t.Fatal("want an error")
	}
	if le.Code != ldapx.CodeConnectError && le.Code != ldapx.CodeServerDown && le.Code != ldapx.CodeTimeout {
		t.Fatalf("unexpected %+v", le)
	}
}

func TestStoppedServerIsServerDown(t *testing.T) {
	srv := testldap.New(t)
	url := srv.LDAPURL()
	if err := srv.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, le := open(t, ldapx.Params{URL: url, Security: ldapx.SecurityNone, Bind: ldapx.BindAnonymous, Timeout: 3 * time.Second})
	if le == nil || (le.Code != ldapx.CodeServerDown && le.Code != ldapx.CodeTimeout) {
		t.Fatalf("want -1 (or -5 behind a port forwarder), got %+v", le)
	}
}
