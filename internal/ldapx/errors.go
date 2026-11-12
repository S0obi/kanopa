package ldapx

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// Client-side result codes, as OpenLDAP's libldap numbers them.
const (
	CodeServerDown   = -1
	CodeTimeout      = -5
	CodeConnectError = -11
)

// Error is an LDAP failure worded for the person at the keyboard: what failed,
// what to do, then the result code.
type Error struct {
	Code   int    `json:"code"`
	Name   string `json:"name"`   // "Invalid credentials"
	Title  string `json:"title"`  // "Bind refused."
	Detail string `json:"detail"` // sentences ending with the fix
	// Lead puts the code first, as the design words refused changes:
	// "Object class violation (65) — inetOrgPerson requires the attribute sn."
	Lead  bool `json:"lead"`
	cause error
}

// Text is the full sentence the UI shows: "<detail> <name> (<code>)", or with Lead
// "<name> (<code>) — <detail>".
func (e *Error) Text() string {
	if e.Lead {
		return fmt.Sprintf("%s (%d) — %s", e.Name, e.Code, e.Detail)
	}
	return fmt.Sprintf("%s %s (%d)", e.Detail, e.Name, e.Code)
}

func (e *Error) Error() string { return e.Text() }
func (e *Error) Unwrap() error { return e.cause }

var codeNames = map[int]string{
	CodeServerDown:   "Can't contact LDAP server",
	CodeTimeout:      "Timeout",
	CodeConnectError: "Connect error",
	1:                "Operations error",
	2:                "Protocol error",
	3:                "Time limit exceeded",
	4:                "Size limit exceeded",
	7:                "Auth method not supported",
	8:                "Stronger auth required",
	10:               "Referral",
	11:               "Admin limit exceeded",
	12:               "Unavailable critical extension",
	13:               "Confidentiality required",
	16:               "No such attribute",
	17:               "Undefined attribute type",
	18:               "Inappropriate matching",
	19:               "Constraint violation",
	20:               "Type or value exists",
	21:               "Invalid syntax",
	32:               "No such object",
	33:               "Alias problem",
	34:               "Invalid DN syntax",
	36:               "Alias dereferencing problem",
	48:               "Inappropriate authentication",
	49:               "Invalid credentials",
	50:               "Insufficient access",
	51:               "Busy",
	52:               "Server is unavailable",
	53:               "Unwilling to perform",
	54:               "Loop detected",
	64:               "Naming violation",
	65:               "Object class violation",
	66:               "Not allowed on non-leaf",
	67:               "Not allowed on RDN",
	68:               "Entry already exists",
	69:               "Object class mods prohibited",
	71:               "Affects multiple DSAs",
	80:               "Other",
	122:              "Assertion failed",
}

// CodeName returns the sentence-case name of a result code.
func CodeName(code int) string {
	if n, ok := codeNames[code]; ok {
		return n
	}
	return "Unknown result"
}

// Op describes what was being attempted, so errors can name the server and the account.
type Op struct {
	Endpoint Endpoint
	Security Security
	BindDN   string
	Timeout  time.Duration
	Stage    Stage
}

// Stage is the step that failed.
type Stage int

const (
	StageDial Stage = iota
	StageStartTLS
	StageBind
	StageRead
	StageWrite
)

func newErr(code int, title, detail string, cause error) *Error {
	return &Error{Code: code, Name: CodeName(code), Title: title, Detail: detail, cause: cause}
}

// Classify turns any error from dialing, StartTLS, binding or reading into an *Error.
func Classify(err error, op Op) *Error {
	if err == nil {
		return nil
	}
	var ke *Error
	if errors.As(err, &ke) {
		return ke
	}
	hp := op.Endpoint.HostPort()
	secs := int(op.Timeout.Round(time.Second) / time.Second)
	if secs < 1 {
		secs = 1
	}

	// Server answers first: these carry a real LDAP result code.
	var le *ldap.Error
	if errors.As(err, &le) && le.ResultCode < 200 {
		return classifyResult(int(le.ResultCode), le, op)
	}

	if le != nil && le.ResultCode == ldap.ErrorEmptyPassword {
		return newErr(49, "Password missing.",
			fmt.Sprintf("Enter the password for %s, or choose Anonymous.", op.BindDN), err)
	}

	// Below: transport failures, whatever wraps them.
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return newErr(CodeServerDown, "Host not found.",
			fmt.Sprintf("Kanopa can't find the host %s. Check the host name, then try again.", op.Endpoint.Host), err)
	}
	if isTimeout(err) {
		return newErr(CodeTimeout, "No answer.",
			fmt.Sprintf("Nothing came back from %s within %d seconds. Check your VPN or network, then try again.", hp, secs), err)
	}
	if isRefused(err) {
		fix := "Check that the server is running and that the host and port are right, then try again."
		if op.Endpoint.IsLocal() {
			fix = "Start the LDAP server on this computer, then try again."
		}
		return newErr(CodeServerDown, "Server not running.",
			fmt.Sprintf("Nothing answered on %s. %s", hp, fix), err)
	}
	if reason, ok := certProblem(err); ok {
		return newErr(CodeConnectError, "Certificate not trusted.",
			fmt.Sprintf("The certificate of %s is not trusted: %s. Add its certificate authority to the system trust store, or turn off certificate verification for a test server.", op.Endpoint.Host, reason), err)
	}
	if isTLSMismatch(err) {
		return newErr(CodeConnectError, "Not an LDAPS port.",
			fmt.Sprintf("%s didn't answer with TLS. Use ldap:// with StartTLS for this port, or check the port number.", hp), err)
	}
	if errors.Is(err, io.EOF) || isReset(err) {
		return newErr(CodeServerDown, "Connection closed.",
			fmt.Sprintf("%s closed the connection without answering. Check that the server is running, that the port speaks LDAP and that the encryption setting matches it, then try again.", hp), err)
	}
	return newErr(CodeConnectError, "Connection failed.",
		fmt.Sprintf("Kanopa couldn't talk to %s: %s.", hp, rootMessage(err)), err)
}

func classifyResult(code int, le *ldap.Error, op Op) *Error {
	hp := op.Endpoint.HostPort()
	diag := ""
	if le.Err != nil {
		diag = strings.TrimSpace(le.Err.Error())
	}
	switch {
	case op.Stage == StageWrite && writeErrors[code] != nil:
		e := writeErrors[code](diag, le)
		e.Lead = true
		return e
	case op.Stage == StageWrite:
		e := newErr(code, "Change refused.", serverSaid(diag, "the server refused the change."), le)
		e.Lead = true
		return e
	case code == 49:
		return newErr(49, "Bind refused.",
			fmt.Sprintf("The server refused the password for %s. Enter the current password, then try again.", op.BindDN), le)
	case code == 48 && op.BindDN == "":
		return newErr(48, "Anonymous bind refused.",
			"The server doesn't accept anonymous binds. Choose Simple bind and enter a bind DN.", le)
	case code == 13:
		return newErr(13, "Encryption required.",
			fmt.Sprintf("%s only accepts encrypted connections. Choose LDAPS or StartTLS.", hp), le)
	case code == 34:
		return newErr(34, "Invalid DN.",
			fmt.Sprintf("The server couldn't read the bind DN %s. A bind DN looks like cn=admin,dc=example,dc=org.", op.BindDN), le)
	case op.Stage == StageStartTLS:
		return newErr(code, "StartTLS refused.",
			fmt.Sprintf("%s refused StartTLS. Use LDAPS, or choose None for a server on this computer.", hp), le)
	case code == 52 || code == 51:
		return newErr(code, "Server unavailable.",
			fmt.Sprintf("%s is not accepting requests right now. Try again in a moment.", hp), le)
	}
	detail := "The server refused the request."
	if diag != "" {
		detail = "The server said: " + strings.TrimSuffix(diag, ".") + "."
	}
	return newErr(code, "Request refused.", detail, le)
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	var le *ldap.Error
	// go-ldap's own request timeout reads "ldap: connection timed out"; when it fires before
	// Kanopa's deadline (the two race), it is still the same "No answer".
	if errors.As(err, &le) && le.Err != nil {
		if s := strings.ToLower(le.Err.Error()); strings.Contains(s, "timeout") || strings.Contains(s, "timed out") {
			return true
		}
	}
	return false
}

func isRefused(err error) bool {
	if errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "connection refused") || strings.Contains(s, "actively refused")
}

func isReset(err error) bool {
	if errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "connection reset") || strings.Contains(s, "forcibly closed") || strings.Contains(s, "connection closed") ||
		strings.HasSuffix(s, ": eof") || strings.Contains(s, "unable to read ldap response packet")
}

func isTLSMismatch(err error) bool {
	var rh tls.RecordHeaderError
	if errors.As(err, &rh) {
		return true
	}
	s := err.Error()
	return strings.Contains(s, "first record does not look like a TLS handshake")
}

func certProblem(err error) (string, bool) {
	var ua x509.UnknownAuthorityError
	if errors.As(err, &ua) {
		return "it is signed by an unknown authority", true
	}
	var he x509.HostnameError
	if errors.As(err, &he) {
		return fmt.Sprintf("it is not valid for the name %s", he.Host), true
	}
	var ci x509.CertificateInvalidError
	if errors.As(err, &ci) {
		if ci.Reason == x509.Expired {
			return "it has expired or is not valid yet", true
		}
		return "it is not valid", true
	}
	var cv *tls.CertificateVerificationError
	if errors.As(err, &cv) {
		return "it failed verification", true
	}
	return "", false
}

func rootMessage(err error) string {
	for {
		u := errors.Unwrap(err)
		if u == nil {
			return strings.TrimSuffix(err.Error(), ".")
		}
		err = u
	}
}

// writeErrors word the refusals of a change. diag is the server's own message, possibly empty.
// writeErrors word the refusals of a change, in the design's form: "<name> (<code>) — <detail>".
// diag is the server's own message, possibly empty.
var writeErrors = map[int]func(diag string, le *ldap.Error) *Error{
	16: func(_ string, le *ldap.Error) *Error {
		return newErr(16, "Entry changed meanwhile.",
			"a value you removed is no longer there. Reload the entry, then make your changes again.", le)
	},
	19: func(diag string, le *ldap.Error) *Error {
		return newErr(19, "Change refused.", serverSaid(diag, "a value breaks a rule of the server, such as a single value or a password policy."), le)
	},
	20: func(diag string, le *ldap.Error) *Error {
		return newErr(20, "Value already there.", serverSaid(diag, "a value you added is already in the entry."), le)
	},
	21: func(diag string, le *ldap.Error) *Error {
		return newErr(21, "Invalid value.", serverSaid(diag, "a value doesn't match the syntax of its attribute."), le)
	},
	32: func(_ string, le *ldap.Error) *Error {
		return newErr(32, "Entry gone.", "this entry no longer exists: someone deleted or renamed it. Reload the tree.", le)
	},
	50: func(_ string, le *ldap.Error) *Error {
		return newErr(50, "Not allowed.", "the account you bound as may not change this entry. Connect as an account with write access.", le)
	},
	53: func(diag string, le *ldap.Error) *Error {
		return newErr(53, "Change refused.", serverSaid(diag, "the server won't make this change."), le)
	},
	65: func(diag string, le *ldap.Error) *Error {
		if class, attr, ok := requiresAttr(diag); ok {
			return newErr(65, "Required attribute missing.", fmt.Sprintf("%s requires the attribute %s.", class, attr), le)
		}
		return newErr(65, "Object class rules broken.", serverSaid(diag, "the entry would break the rules of its object classes."), le)
	},
	64: func(diag string, le *ldap.Error) *Error {
		return newErr(64, "Name refused.", serverSaid(diag, "the server doesn't accept this name for the entry here."), le)
	},
	66: func(_ string, le *ldap.Error) *Error {
		return newErr(66, "Entry has children.", "this entry has entries below it. Delete them first.", le)
	},
	68: func(_ string, le *ldap.Error) *Error {
		return newErr(68, "Name taken.", "an entry with this DN already exists. Choose another name.", le)
	},
	67: func(_ string, le *ldap.Error) *Error {
		return newErr(67, "Value names the entry.", "you can't remove the value that names this entry (its RDN).", le)
	},
	122: func(_ string, le *ldap.Error) *Error {
		return newErr(122, "Entry changed meanwhile.", "someone changed this entry since you read it. Reload the entry, then make your changes again.", le)
	},
}

// serverSaid is the server's own message when it gave one, else the fallback; one sentence.
func serverSaid(diag, fallback string) string {
	if diag = strings.TrimSpace(diag); diag == "" {
		return fallback
	}
	return strings.TrimSuffix(diag, ".") + "."
}

// Conflict is the refusal of a change to an entry whose edited attributes changed on the
// server since they were read. attrs names them when known.
func Conflict(attrs []string) *Error {
	what := "someone changed this entry since you read it."
	switch n := len(attrs); {
	case n == 1:
		what = attrs[0] + " changed on the server since you read it."
	case n > 1:
		what = strings.Join(attrs[:n-1], ", ") + " and " + attrs[n-1] + " changed on the server since you read them."
	}
	return &Error{Code: 122, Name: CodeName(122), Title: "Entry changed meanwhile.", Lead: true,
		Detail: what + " Reload the entry, then make your changes again."}
}

// requiresAttr reads OpenLDAP's "object class 'inetOrgPerson' requires attribute 'sn'".
func requiresAttr(diag string) (class, attr string, ok bool) {
	quoted := func(s string) (string, string, bool) {
		i := strings.IndexByte(s, '\'')
		if i < 0 {
			return "", "", false
		}
		j := strings.IndexByte(s[i+1:], '\'')
		if j < 0 {
			return "", "", false
		}
		return s[i+1 : i+1+j], s[i+2+j:], true
	}
	i := strings.Index(diag, "object class ")
	if i < 0 || !strings.Contains(diag, " requires attribute ") {
		return "", "", false
	}
	class, rest, ok := quoted(diag[i:])
	if !ok {
		return "", "", false
	}
	attr, _, ok = quoted(rest)
	return class, attr, ok
}
