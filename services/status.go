package services

import (
	"context"
	"strings"
	"time"

	"github.com/S0obi/kanopa/internal/ldapx"
)

// adminLock is the value ppolicy stores when an administrator locks an account: it never runs out.
const adminLock = "000001010000Z"

// AccountStatus is what a person's password state means for signing in, as the entry view shows it.
type AccountStatus struct {
	// Locked: the account cannot sign in now. LockedAt is when the lock was set (RFC 3339, UTC),
	// LockedValue the stored value Unlock removes, and LockedByAdmin tells an administrator's lock apart.
	Locked        bool   `json:"locked"`
	LockedAt      string `json:"lockedAt"`
	LockedValue   string `json:"lockedValue"`
	LockedByAdmin bool   `json:"lockedByAdmin"`
	// LockMayHaveEnded: the lock came from failed sign-ins and Kanopa cannot read the policy that says how
	// long it lasts, so it may have run out already.
	LockMayHaveEnded bool `json:"lockMayHaveEnded"`
	// MustChange: the person must choose a new password at the next sign-in (pwdReset).
	MustChange bool `json:"mustChange"`
	// Expired: the password is older than the policy's pwdMaxAge allows. Only said when the policy was read.
	Expired   bool     `json:"expired"`
	ExpiredAt string   `json:"expiredAt"` // RFC 3339, UTC
	Failure   *Failure `json:"failure"`
}

// parseLDAPTime reads a generalized time such as 20261115094012Z (fractions and a missing seconds field allowed).
func parseLDAPTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if before, _, ok := strings.Cut(s, "."); ok {
		s = before + "Z"
	}
	for _, layout := range []string{"20060102150405Z", "200601021504Z"} {
		// Year 0000 is how ppolicy writes "locked until someone unlocks it", not a date.
		if t, err := time.Parse(layout, s); err == nil && t.Year() >= 1970 {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// statusOf says what a password state means at now. The rules come from what the test server's
// overlay does (test/ldap/README.md):
//   - a lock counts only where the policy locks at all, and a lock from failed sign-ins ends after its
//     duration (the attribute stays until the next good sign-in, so it is not read as locked);
//   - when the policy cannot be read, a lock is reported as it is, with a note that it may have ended;
//   - expiry is only said when the policy was read: otherwise the default applies and Kanopa cannot see it.
func statusOf(st ldapx.PasswordState, now time.Time) AccountStatus {
	out := AccountStatus{MustChange: st.Reset}
	if st.LockedTime != "" {
		at, ok := parseLDAPTime(st.LockedTime)
		byAdmin := strings.EqualFold(st.LockedTime, adminLock)
		switch {
		case st.PolicyRead && !st.Lockout:
			// The policy does not lock, so the stored value holds nobody out.
		case byAdmin:
			out.Locked, out.LockedByAdmin = true, true
		case !ok:
			out.Locked = true
		case st.PolicyRead && st.LockoutDuration > 0:
			out.Locked = now.Before(at.Add(time.Duration(st.LockoutDuration) * time.Second))
		default:
			out.Locked = true
			out.LockMayHaveEnded = !st.PolicyRead
		}
		if out.Locked {
			out.LockedValue = st.LockedTime
			if ok && !byAdmin {
				out.LockedAt = at.Format(time.RFC3339)
			}
		}
	}
	if st.PolicyRead && st.MaxAge > 0 && st.ChangedTime != "" {
		if changed, ok := parseLDAPTime(st.ChangedTime); ok {
			if end := changed.Add(time.Duration(st.MaxAge) * time.Second); end.Before(now) {
				out.Expired, out.ExpiredAt = true, end.Format(time.RFC3339)
			}
		}
	}
	return out
}

// AccountStatus reads whether a person's account is locked, must change its password or has an expired one.
// It needs the ppolicy overlay: on a server without it the answer is "no known problem".
func (d *DirectoryService) AccountStatus(ctx context.Context, id, dn string) AccountStatus {
	l, f := d.session(id)
	if f != nil {
		return AccountStatus{Failure: f}
	}
	st, err := l.PasswordState(ctx, dn)
	if err != nil {
		return AccountStatus{Failure: d.fail(l, err)}
	}
	return statusOf(st, time.Now())
}
