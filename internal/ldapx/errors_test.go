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

func TestWriteRefusalsAreNotWordedAsBinds(t *testing.T) {
	op := Op{Endpoint: Endpoint{Host: "ldap.example.org", Port: 636}, BindDN: "cn=admin,dc=example,dc=org", Stage: StageWrite}
	e := Classify(ldap.NewError(34, errors.New("invalid DN")), op)
	if e.Code != 34 || strings.Contains(e.Detail, "bind DN") || e.Text() != "Invalid DN syntax (34) — invalid DN." {
		t.Fatalf("write 34: %+v", e)
	}
	if e := Classify(ldap.NewError(122, errors.New("")), op); e.Title != "Entry changed meanwhile." {
		t.Fatalf("write 122: %+v", e)
	}
}

// Refused changes read as the design words them: "<name> (<code>) — <detail>".
func TestWriteRefusalsInTheDesignsWording(t *testing.T) {
	op := Op{Endpoint: Endpoint{Host: "ldap.example.org", Port: 636}, BindDN: "cn=admin,dc=example,dc=org", Stage: StageWrite}
	cases := []struct {
		code uint16
		diag string
		want string
	}{
		{65, "object class 'inetOrgPerson' requires attribute 'sn'", "Object class violation (65) — inetOrgPerson requires the attribute sn."},
		{19, "attribute 'displayName' cannot have multiple values", "Constraint violation (19) — attribute 'displayName' cannot have multiple values."},
		{20, "modify/add: telephoneNumber: value #0 already exists", "Type or value exists (20) — modify/add: telephoneNumber: value #0 already exists."},
		{21, "", "Invalid syntax (21) — a value does not match the syntax of its attribute."},
		{50, "no write access to parent", "Insufficient access (50) — the account you bound as may not change this entry. Connect as an account with write access."},
	}
	for _, c := range cases {
		if got := Classify(ldap.NewError(c.code, errors.New(c.diag)), op).Text(); got != c.want {
			t.Errorf("%d: got %q, want %q", c.code, got, c.want)
		}
	}
	// Reads and binds keep the code at the end.
	if got := Classify(ldap.NewError(50, errors.New("")), Op{Stage: StageRead}).Text(); !strings.HasSuffix(got, "Insufficient access (50)") {
		t.Errorf("read 50: %q", got)
	}
}

func TestConflictNamesTheAttributes(t *testing.T) {
	for _, c := range []struct {
		attrs []string
		want  string
	}{
		{nil, "Assertion failed (122) — someone changed this entry since you read it. Reload the entry, then make your changes again."},
		{[]string{"title"}, "Assertion failed (122) — title changed on the server since you read it. Reload the entry, then make your changes again."},
		{[]string{"title", "mail", "cn"}, "Assertion failed (122) — title, mail and cn changed on the server since you read them. Reload the entry, then make your changes again."},
	} {
		if got := Conflict(c.attrs).Text(); got != c.want {
			t.Errorf("%v: got %q", c.attrs, got)
		}
	}
}

// go-ldap's request timeout and Kanopa's deadline race on a silent server: whichever fires
// first, the person reads "No answer".
func TestGoLDAPTimeoutIsNoAnswer(t *testing.T) {
	op := Op{Endpoint: Endpoint{Host: "127.0.0.1", Port: 33757}, Timeout: time.Second, Stage: StageBind}
	e := Classify(ldap.NewError(ldap.ErrorNetwork, errors.New("ldap: connection timed out")), op)
	if e.Code != CodeTimeout || e.Title != "No answer." {
		t.Fatalf("got %+v", e)
	}
}
