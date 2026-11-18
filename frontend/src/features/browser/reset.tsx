import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBackend, type EntryView, type SessionInfo } from "@/api/backend";
import { Banner, Checkbox, Dialog } from "@/ui";
import { useChanges, type PendingAttr } from "./changes";
import { PasswordPair, passwordErrors, passwordHint } from "./editors";

/** The attribute that asks for a new password at the next sign-in (the ppolicy overlay's). */
export const MUST_CHANGE_ATTR = "pwdReset";

/**
 * Reset password: a new password for one person, typed twice or generated, and when the server has a
 * password policy, whether the person must choose their own at the next sign-in. It adds to the pending
 * changes like any edit; nothing is sent until Apply. The tree's menu, the entry's menu and Edit on the
 * userPassword row all open this one dialog.
 */
export function ResetPasswordDialog({ connectionId, entry, session, onClose }: { connectionId: string; entry: EntryView; session: SessionInfo; onClose: () => void }) {
  const backend = useBackend();
  const stage = useChanges((s) => s.stage);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [generated, setGenerated] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [tried, setTried] = useState(false);

  const hasPolicy = session.passwordPolicy;
  const policy = useQuery({
    queryKey: ["passwordPolicy", connectionId, entry.dn],
    queryFn: () => backend.passwordPolicy(connectionId, entry.dn),
    enabled: hasPolicy,
    staleTime: 60_000,
  });
  // The entry's own policy asks for it: the server sets the flag itself, so Kanopa sends nothing for it.
  const required = hasPolicy && !!policy.data && !policy.data.failure && policy.data.mustChange;
  const encrypted = session.security === "LDAPS" || session.security === "StartTLS";
  const errors = passwordErrors(password, confirm, true);

  function save() {
    setTried(true);
    if (errors.length) return;
    const current = (entry.attributes ?? []).find((a) => a.name.toLowerCase() === "userpassword");
    const ids = current?.ids ?? [];
    const shown: Record<string, string> = {};
    ids.forEach((id, i) => (shown[id] = current?.values?.[i] ?? id));
    const pw: PendingAttr = { name: current?.name ?? "userPassword", kind: "password", before: ids, after: ids, shown, password, generated: generated || undefined };
    stage(connectionId, entry, pw);
    if (hasPolicy && !required) {
      // Staged after the password, and dropped again when the box is unchecked and nothing else is pending.
      const was = (entry.attributes ?? []).find((a) => a.name.toLowerCase() === MUST_CHANGE_ATTR.toLowerCase())?.values ?? [];
      stage(connectionId, entry, { name: MUST_CHANGE_ATTR, kind: "text", before: was, after: mustChange ? ["TRUE"] : was });
    }
    onClose();
  }

  return (
    <Dialog
      title="Reset password"
      description={
        <>
          For {entry.title} · <code className="kn-changes__dn">{entry.dn}</code>
        </>
      }
      onClose={onClose}
      width={560}
      footerStart={<span className="text-[12px] leading-4 text-ink-muted">Nothing is sent until you apply pending changes.</span>}
      secondaryAction={{ label: "Cancel", onClick: onClose }}
      primaryAction={{ label: "Add to changes", onClick: save }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "checkbox") {
            e.preventDefault();
            save();
          }
        }}
      >
        <PasswordPair
          value={password}
          confirm={confirm}
          generated={generated}
          onChange={setPassword}
          onConfirm={setConfirm}
          onGeneratedChange={setGenerated}
          autoFocus
          invalid={tried && errors.length > 0}
          hint={passwordHint(session.security)}
        />
        {hasPolicy && (
          <Checkbox
            checked={required || mustChange}
            disabled={required}
            onChange={(e) => setMustChange(e.target.checked)}
            label={
              <span className="flex flex-col">
                <span>User must change password at next login</span>
                <span className="text-[12px] leading-4 text-ink-muted">{required ? "Your server's password policy requires this." : "Sets pwdReset. The server asks for a new password at the next bind."}</span>
              </span>
            }
          />
        )}
        {!encrypted && (
          <Banner tone="warning" title="Not encrypted.">
            This connection uses neither LDAPS nor StartTLS: the new password crosses the network as plain text.
          </Banner>
        )}
        {tried && errors.length > 0 && (
          <Banner tone="danger" title={errors[0]!.startsWith("Constraint") ? "Enter a password." : "The passwords differ."}>
            {errors[0]}
          </Banner>
        )}
      </form>
    </Dialog>
  );
}
