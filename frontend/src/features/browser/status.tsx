import { useQuery } from "@tanstack/react-query";
import { useBackend, type AccountStatus, type EntryView, type SessionInfo } from "@/api/backend";
import { formatDay, formatMoment } from "@/lib/time";
import { Banner, Button } from "@/ui";
import { pendingOf, useChanges } from "./changes";

/** The attribute Unlock removes. */
const LOCK_ATTR = "pwdAccountLockedTime";

/**
 * One banner above a person's attributes when the password policy says something about signing in:
 * locked (with Unlock), password expired (with Reset password…), or must change at the next login. The most
 * serious state sets the colour and the one action, and the others follow as a sentence. No banner means no
 * known problem, not a guarantee: expiry is only said where Kanopa can read the policy.
 */
export function AccountStatusBanner({ id, entry, session, canWrite, onReset }: { id: string; entry: EntryView; session: SessionInfo; canWrite: boolean; onReset: () => void }) {
  const backend = useBackend();
  const stage = useChanges((s) => s.stage);
  const pending = useChanges((s) => pendingOf(s.byConnection[id], entry.dn, LOCK_ATTR));
  const q = useQuery({
    queryKey: ["accountStatus", id, entry.dn],
    queryFn: () => backend.accountStatus(id, entry.dn),
    enabled: session.passwordPolicy && entry.type === "person",
    staleTime: 15_000,
  });
  const st = q.data && !q.data.failure ? q.data : null;
  if (!st) return null;

  const name = entry.title;
  const unlocking = !!pending && pending.after.length === 0;
  const setLock = (remove: boolean) =>
    stage(id, entry, { name: LOCK_ATTR, kind: "text", before: [st.lockedValue], after: remove ? [] : [st.lockedValue] });

  if (unlocking)
    return (
      <Banner tone="success" role="status" title="Unlock pending." actions={<Button onClick={() => setLock(false)}>Undo unlock</Button>}>
        The lock is removed when you apply pending changes.
      </Banner>
    );

  const unlock = canWrite && st.locked ? (
    <Button onClick={() => setLock(true)}>Unlock</Button>
  ) : undefined;
  const reset = canWrite && !session.activeDirectory ? (
    <Button onClick={onReset}>Reset password…</Button>
  ) : undefined;
  const sentences = [
    st.locked && st.expired ? `The password also expired on ${formatDay(st.expiredAt)}.` : "",
    st.locked && st.mustChange ? `${name} must choose a new password at the next login.` : "",
  ].filter(Boolean);

  if (st.locked) {
    const since = st.lockedAt ? `The lock was set on ${formatMoment(st.lockedAt)}. ` : "";
    const body = st.lockedByAdmin
      ? `${name} can't log in until someone unlocks the account.`
      : st.lockMayHaveEnded
        ? `${since}It may have expired already: Kanopa can't read how long the lock lasts.`
        : `${since}${name} can't log in until it expires or you unlock the account.`;
    return (
      <Banner tone="danger" role="status" title={st.lockedByAdmin ? "Locked by an admin." : "Locked after failed logins."} actions={unlock}>
        {[body, ...sentences].join(" ")}
      </Banner>
    );
  }
  if (st.expired)
    return (
      <Banner tone="warning" title="Password expired." actions={reset}>
        {`It expired on ${formatDay(st.expiredAt)}. ${name} can't log in until the password is reset.`}
      </Banner>
    );
  if (st.mustChange)
    return (
      <Banner tone="warning" title="Must change password.">
        {`${name} chooses a new password at the next login. The server asks for it at that sign-in.`}
      </Banner>
    );
  return null;
}

export type { AccountStatus };
