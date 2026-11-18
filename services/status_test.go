package services

import (
	"testing"
	"time"

	"github.com/S0obi/kanopa/internal/ldapx"
)

func TestStatusOf(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	readable := func(st ldapx.PasswordState) ldapx.PasswordState {
		st.PolicyDN, st.PolicyRead = "cn=p,ou=policies,dc=example,dc=org", true
		return st
	}
	for _, c := range []struct {
		name string
		st   ldapx.PasswordState
		want AccountStatus
	}{
		{"nothing known", ldapx.PasswordState{}, AccountStatus{}},
		{"locked until someone unlocks it", readable(ldapx.PasswordState{LockedTime: "20261115094012Z", Lockout: true}),
			AccountStatus{Locked: true, LockedAt: "2026-11-15T09:40:12Z", LockedValue: "20261115094012Z"}},
		{"locked, the duration has not run out", readable(ldapx.PasswordState{LockedTime: "20261118115500Z", Lockout: true, LockoutDuration: 900}),
			AccountStatus{Locked: true, LockedAt: "2026-11-18T11:55:00Z", LockedValue: "20261118115500Z"}},
		{"the lock has run out under a readable policy: no lock", readable(ldapx.PasswordState{LockedTime: "20261115094012Z", Lockout: true, LockoutDuration: 900}), AccountStatus{}},
		{"a policy that does not lock holds nobody out", readable(ldapx.PasswordState{LockedTime: "20261115094012Z", Lockout: false}), AccountStatus{}},
		{"an administrator's lock", readable(ldapx.PasswordState{LockedTime: "000001010000Z", Lockout: true, LockoutDuration: 900}),
			AccountStatus{Locked: true, LockedByAdmin: true, LockedValue: "000001010000Z"}},
		{"locked, policy not readable: it may have ended", ldapx.PasswordState{LockedTime: "20261115094012Z", PolicyDN: "cn=x,dc=example,dc=org"},
			AccountStatus{Locked: true, LockedAt: "2026-11-15T09:40:12Z", LockedValue: "20261115094012Z", LockMayHaveEnded: true}},
		{"an administrator's lock is never 'may have ended'", ldapx.PasswordState{LockedTime: "000001010000Z"},
			AccountStatus{Locked: true, LockedByAdmin: true, LockedValue: "000001010000Z"}},
		{"must change", ldapx.PasswordState{Reset: true}, AccountStatus{MustChange: true}},
		{"expired under a readable policy", readable(ldapx.PasswordState{ChangedTime: "20260813080000Z", MaxAge: 7776000}),
			AccountStatus{Expired: true, ExpiredAt: "2026-11-11T08:00:00Z"}},
		{"not yet expired", readable(ldapx.PasswordState{ChangedTime: "20261101000000Z", MaxAge: 7776000}), AccountStatus{}},
		{"a max age of 0 never expires", readable(ldapx.PasswordState{ChangedTime: "20200101000000Z", MaxAge: 0}), AccountStatus{}},
		{"expiry is not guessed without the policy", ldapx.PasswordState{ChangedTime: "20200101000000Z"}, AccountStatus{}},
		{"a password never changed through the server does not age", readable(ldapx.PasswordState{MaxAge: 7776000}), AccountStatus{}},
		{"locked, must change and expired at once", readable(ldapx.PasswordState{LockedTime: "20261115094012Z", Lockout: true, Reset: true, ChangedTime: "20200101000000Z", MaxAge: 2592000}),
			AccountStatus{Locked: true, LockedAt: "2026-11-15T09:40:12Z", LockedValue: "20261115094012Z", MustChange: true, Expired: true, ExpiredAt: "2020-01-31T00:00:00Z"}},
	} {
		if got := statusOf(c.st, now); got != c.want {
			t.Errorf("%s:\n got  %+v\n want %+v", c.name, got, c.want)
		}
	}
}

func TestParseLDAPTime(t *testing.T) {
	for in, want := range map[string]string{
		"20261115094012Z":     "2026-11-15T09:40:12Z",
		"20261115094012.0Z":   "2026-11-15T09:40:12Z",
		"20261115094012.123Z": "2026-11-15T09:40:12Z",
		"202611150940Z":       "2026-11-15T09:40:00Z",
	} {
		got, ok := parseLDAPTime(in)
		if !ok || got.Format(time.RFC3339) != want {
			t.Errorf("%q: %v %v, want %s", in, got, ok, want)
		}
	}
	if _, ok := parseLDAPTime("000001010000Z"); ok {
		t.Error("the administrator's value is not a real date")
	}
	if _, ok := parseLDAPTime("tomorrow"); ok {
		t.Error("not a time")
	}
}
