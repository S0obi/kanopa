package ldapx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"
)

// A server that accepts connections and never says a word.
func silentServer(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { c.Close() })
		}
	}()
	return ln.Addr().String()
}

func closedPort(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func codeOf(t *testing.T, err error) int {
	t.Helper()
	var le *Error
	if !errors.As(err, &le) {
		t.Fatalf("want *Error, got %T %v", err, err)
	}
	return le.Code
}

func TestOpenTimesOutOnSilentServer(t *testing.T) {
	addr := silentServer(t)
	start := time.Now()
	_, err := Open(context.Background(), Params{URL: "ldap://" + addr, Security: SecurityNone, Bind: BindSimple,
		BindDN: "cn=admin,dc=example,dc=org", Password: "x", Timeout: time.Second})
	if code := codeOf(t, err); code != CodeTimeout {
		t.Fatalf("code = %d (%v), want %d", code, err, CodeTimeout)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("took %v, the timeout is 1s", d)
	}
}

func TestOpenLDAPSHandshakeTimesOut(t *testing.T) {
	addr := silentServer(t)
	_, err := Open(context.Background(), Params{URL: "ldaps://" + addr, Security: SecurityLDAPS, Bind: BindAnonymous, Timeout: time.Second})
	if code := codeOf(t, err); code != CodeTimeout {
		t.Fatalf("code = %d (%v), want %d", code, err, CodeTimeout)
	}
}

func TestOpenRefused(t *testing.T) {
	addr := closedPort(t)
	_, err := Open(context.Background(), Params{URL: "ldap://" + addr, Security: SecurityNone, Bind: BindAnonymous, Timeout: 2 * time.Second})
	if code := codeOf(t, err); code != CodeServerDown {
		t.Fatalf("code = %d (%v), want %d", code, err, CodeServerDown)
	}
}

func TestOpenRejectsBadURL(t *testing.T) {
	_, err := Open(context.Background(), Params{URL: "example.org"})
	if !errors.Is(err, ErrInvalidURL) {
		t.Fatalf("err = %v", err)
	}
}

func TestOpenRespectsCallerCancel(t *testing.T) {
	addr := silentServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	start := time.Now()
	_, err := Open(ctx, Params{URL: fmt.Sprintf("ldap://%s", addr), Security: SecurityNone, Bind: BindSimple, BindDN: "cn=x", Password: "x", Timeout: 10 * time.Second})
	if err == nil {
		t.Fatal("want an error")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("cancel took %v", d)
	}
}
