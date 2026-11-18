package services

import (
	"testing"

	"github.com/S0obi/kanopa/internal/ldapx"
)

// pwdReset is written again under the Relax Rules control when the server refused the plain write
// for a reason that control can lift, and not for any other.
func TestRefusedPolicyWrite(t *testing.T) {
	for code, want := range map[int]bool{19: true, 50: true, 53: true, 32: false, 49: false, 122: false} {
		if got := refusedPolicyWrite(&ldapx.Error{Code: code}); got != want {
			t.Errorf("code %d: %v, want %v", code, got, want)
		}
	}
	if refusedPolicyWrite(nil) {
		t.Error("no error is not a refusal")
	}
}

func TestIsPolicyAttr(t *testing.T) {
	if !isPolicyAttr("pwdReset") || !isPolicyAttr("PWDRESET") || !isPolicyAttr("pwdAccountLockedTime") || isPolicyAttr("userPassword") {
		t.Error("only pwdReset and pwdAccountLockedTime are written after the password")
	}
}
