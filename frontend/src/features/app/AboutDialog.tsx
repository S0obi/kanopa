import { useQuery } from "@tanstack/react-query";
import { useBackend, errorText } from "@/api/backend";
import { Button, Dialog, Logo, Spinner, useToasts } from "@/ui";
import { useApp } from "@/stores/app";

/** What Kanopa is and what it runs on, with what a bug report needs. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const view = useApp((s) => s.view);
  const about = useQuery({ queryKey: ["about"], queryFn: () => backend.about(), staleTime: Infinity });
  const a = about.data;

  async function copyDiagnostics() {
    try {
      let text = await backend.diagnostics();
      // The server's make is part of a bug report; its name and address are not.
      if (view.name === "connected" && view.session.vendor) text += `Server: ${view.session.vendor}\n`;
      await backend.copyText(text);
      toast("Copied the diagnostics.");
    } catch (e) {
      toast(`Kanopa couldn't copy the diagnostics. ${errorText(e)}`, "danger");
    }
  }

  async function open(what: "log" | "repo") {
    try {
      await (what === "log" ? backend.openLogFolder() : backend.openRepo());
    } catch (e) {
      toast(errorText(e), "danger");
    }
  }

  return (
    <Dialog
      title="About Kanopa"
      width={440}
      onClose={onClose}
      primaryAction={{ label: "Copy diagnostics", onClick: () => void copyDiagnostics(), disabled: !a }}
      secondaryAction={{ label: "Close", onClick: onClose }}
      footerStart={
        <Button variant="ghost" onClick={() => void open("log")}>
          Open log folder
        </Button>
      }
    >
      {!a ? (
        <div className="flex items-center gap-2 text-ink-muted">
          <Spinner /> Reading the version…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div className="flex flex-col">
              <span className="type-title">Kanopa</span>
              <span className="text-ink-muted">A calm, exact LDAP client</span>
            </div>
          </div>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">Version</dt>
            <dd className="m-0">
              <code>{a.version}</code>
              {a.commit && <span className="text-ink-muted"> ({a.commit})</span>}
            </dd>
            <dt className="text-ink-muted">System</dt>
            <dd className="m-0">{a.system}</dd>
            {a.webview && (
              <>
                <dt className="text-ink-muted">Web engine</dt>
                <dd className="m-0">{a.webview}</dd>
              </>
            )}
            <dt className="text-ink-muted">License</dt>
            <dd className="m-0">{a.license}</dd>
          </dl>
          <div>
            <Button size="sm" onClick={() => void open("repo")}>
              Open the project page
            </Button>
          </div>
          <p className="m-0 text-[12px] leading-4 text-ink-muted">
            The diagnostics name the versions and the system. They never hold a hostname, an entry or a password.
          </p>
        </div>
      )}
    </Dialog>
  );
}
