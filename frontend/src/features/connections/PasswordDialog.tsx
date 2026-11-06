import { useState } from "react";
import type { SavedConnection } from "@/api/backend";
import type { Platform } from "@/lib/platform";
import { Checkbox, Dialog, TextField } from "@/ui";

/** Asks for a bind password that is not saved, and offers to save it. */
export function PasswordDialog({ conn, store, platform, onCancel, onConnect }: { conn: SavedConnection; store: string; platform: Platform; onCancel: () => void; onConnect: (pw: string, save: boolean) => void }) {
  const [pw, setPw] = useState("");
  const [save, setSave] = useState(false);
  const [tried, setTried] = useState(false);
  const submit = () => (pw ? onConnect(pw, save) : setTried(true));
  return (
    <Dialog
      title={`Connect to ${conn.name}`}
      description={
        <>
          Enter the password for <code>{conn.bindDn}</code>.
        </>
      }
      platform={platform}
      onClose={onCancel}
      primaryAction={{ label: "Connect", onClick: submit }}
      secondaryAction={{ label: "Cancel", onClick: onCancel }}
      width={460}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField label="Password" type="password" mono autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} error={tried && !pw ? "Enter the password." : undefined} />
        <Checkbox label={`Save the password in the ${store}`} checked={save} onChange={(e) => setSave(e.target.checked)} />
      </form>
    </Dialog>
  );
}
