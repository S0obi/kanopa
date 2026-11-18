//go:build integration

package services

import (
	"context"
	"strings"
	"testing"

	"github.com/S0obi/kanopa/internal/testldap"
)

// The status of each fixture account (see test/ldap/README.md), read as a reader and as the admin, and Unlock
// as a staged change: pwdAccountLockedTime is removed on Apply, through the same write path as pwdReset.
func TestAccountStatus(t *testing.T) {
	srv := testldap.New(t)
	s := newTestService(t)
	d := NewDirectoryService(nil, s)
	c := NewChangeService(nil, s)
	ctx := context.Background()
	admin := connectPrivate(t, s, srv, testldap.AdminDN, testldap.AdminPassword)
	reader := connectPrivate(t, s, srv, testldap.ReaderDN, testldap.ReaderPassword)
	status := func(who, uid string) AccountStatus {
		t.Helper()
		st := d.AccountStatus(ctx, who, acctDN(uid))
		if st.Failure != nil {
			t.Fatalf("%s: %+v", uid, st.Failure)
		}
		return st
	}

	t.Run("locked until someone unlocks it", func(t *testing.T) {
		st := status(reader, "acct-locked")
		if !st.Locked || st.LockedByAdmin || st.LockMayHaveEnded || st.LockedAt != "2026-11-15T09:40:00Z" || st.LockedValue != "20261115094000Z" {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("a lock that ran out is no lock, under a policy that can be read", func(t *testing.T) {
		if st := status(reader, "acct-lock-ended"); st.Locked {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("a policy the reader cannot read: the lock is reported, with a note", func(t *testing.T) {
		st := status(reader, "acct-lock-unknown")
		if !st.Locked || !st.LockMayHaveEnded {
			t.Fatalf("reader: %+v", st)
		}
		// The admin can read it, and it says 15 minutes: that lock ended long ago.
		if st := status(admin, "acct-lock-unknown"); st.Locked {
			t.Fatalf("admin: %+v", st)
		}
	})
	t.Run("an administrator's lock", func(t *testing.T) {
		st := status(reader, "acct-admin-locked")
		if !st.Locked || !st.LockedByAdmin || st.LockedAt != "" {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("must change", func(t *testing.T) {
		if st := status(reader, "acct-must-change"); !st.MustChange || st.Locked || st.Expired {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("expired is said only where the policy can be read", func(t *testing.T) {
		if st := status(reader, "acct-expired"); !st.Expired || st.ExpiredAt != "2020-01-31T00:00:00Z" {
			t.Fatalf("strict: %+v", st)
		}
		if st := status(reader, "acct-expired-default"); st.Expired {
			t.Fatalf("expired under the default must not be guessed: %+v", st)
		}
		if st := status(reader, "acct-hidden-policy"); st.Expired {
			t.Fatalf("a policy the reader cannot read must not be guessed: %+v", st)
		}
		if st := status(admin, "acct-hidden-policy"); !st.Expired {
			t.Fatalf("the admin reads that policy: %+v", st)
		}
	})
	t.Run("a healthy account shows nothing", func(t *testing.T) {
		if st := status(reader, "acct-ok"); st != (AccountStatus{}) {
			t.Fatalf("%+v", st)
		}
	})

	t.Run("Unlock is a staged change that removes pwdAccountLockedTime", func(t *testing.T) {
		st := status(admin, "acct-locked")
		change := EntryChange{Op: opModify, DN: acctDN("acct-locked"), Attributes: []AttributeChange{
			{Name: "pwdAccountLockedTime", Kind: "text", Before: []string{st.LockedValue}, After: nil}}}
		if p := c.Preview(admin, []EntryChange{change}); p.Failure != nil || !strings.Contains(p.LDIF, "delete: pwdAccountLockedTime") {
			t.Fatalf("preview %+v", p)
		}
		if r := c.Apply(ctx, admin, []EntryChange{change}); r.Failure != nil || r.Applied != 1 {
			t.Fatalf("apply %+v %+v", r.Failure, r.Results)
		}
		if after := status(admin, "acct-locked"); after.Locked {
			t.Fatalf("still locked: %+v", after)
		}
	})
}
