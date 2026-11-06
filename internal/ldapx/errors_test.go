package ldapx

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
)

func op() Op {
	return Op{Endpoint: Endpoint{"ldaps", "ldap.example.org", 636}, BindDN: "cn=admin,dc=example,dc=org", Timeout: 10 * time.Second}
}

func TestClassify(t *testing.T) {
	local := op()
	local.Endpoint = Endpoint{"ldap", "localhost", 389}
	starttls := op()
	starttls.Stage = StageStartTLS

	cases := []struct {
		name string
		err  error
		op   Op
		code int
		text string
	}{
		{"bad password", ldap.NewError(49, errors.New("")), op(), 49,
			"The server refused the password for cn=admin,dc=example,dc=org. Enter the current password, then try again. Invalid credentials (49)"},
		{"refused remote", &net.OpError{Op: "dial", Err: errors.New("connect: connection refused")}, op(), -1,
			"Nothing answered on ldap.example.org:636. Check that the server is running and that the host and port are right, then try again. Can't contact LDAP server (-1)"},
		{"refused local", ldap.NewError(ldap.ErrorNetwork, &net.OpError{Op: "dial", Err: errors.New("No connection could be made because the target machine actively refused it.")}), local, -1,
			"Nothing answered on localhost:389. Start the LDAP server on this computer, then try again. Can't contact LDAP server (-1)"},
		{"timeout", ldap.NewError(ldap.ErrorNetwork, context.DeadlineExceeded), op(), -5,
			"Nothing came back from ldap.example.org:636 within 10 seconds. Check your VPN or network, then try again. Timeout (-5)"},
		{"dns", ldap.NewError(ldap.ErrorNetwork, &net.DNSError{Name: "ldap.example.org", Err: "no such host", IsNotFound: true}), op(), -1,
			"Kanopa can't find the host ldap.example.org. Check the host name, then try again. Can't contact LDAP server (-1)"},
		{"unknown CA", ldap.NewError(ldap.ErrorNetwork, x509.UnknownAuthorityError{}), op(), -11,
			"The certificate of ldap.example.org is not trusted: it is signed by an unknown authority. Add its certificate authority to the system trust store, or turn off certificate verification for a test server. Connect error (-11)"},
		{"starttls refused", ldap.NewError(2, errors.New("unsupported extended operation")), starttls, 2,
			"ldap.example.org:636 refused StartTLS. Use LDAPS, or choose None for a server on this computer. Protocol error (2)"},
		{"empty password", ldap.NewError(ldap.ErrorEmptyPassword, errors.New("ldap: empty password not allowed by the client")), op(), 49,
			"Enter the password for cn=admin,dc=example,dc=org, or choose Anonymous. Invalid credentials (49)"},
		{"server diagnostic", ldap.NewError(53, errors.New("unauthenticated bind (DN with no password) disallowed")), op(), 53,
			"The server said: unauthenticated bind (DN with no password) disallowed. Unwilling to perform (53)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Classify(c.err, c.op)
			if got.Code != c.code {
				t.Errorf("code = %d, want %d", got.Code, c.code)
			}
			if got.Text() != c.text {
				t.Errorf("text =\n  %q\nwant\n  %q", got.Text(), c.text)
			}
			if got.Title == "" || !strings.HasSuffix(got.Title, ".") {
				t.Errorf("title %q should be a short sentence", got.Title)
			}
		})
	}
}

func TestClassifyKeepsKanopaErrors(t *testing.T) {
	orig := newErr(49, "Bind refused.", "x", nil)
	if got := Classify(fmt.Errorf("wrapped: %w", orig), op()); got != orig {
		t.Fatal("an existing *Error should pass through")
	}
}

func TestCodeName(t *testing.T) {
	if CodeName(65) != "Object class violation" || CodeName(999) != "Unknown result" {
		t.Fatal("unexpected code names")
	}
}
