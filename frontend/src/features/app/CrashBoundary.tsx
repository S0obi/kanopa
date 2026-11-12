import { Component, type ErrorInfo, type ReactNode } from "react";
import { BackendContext, type Backend } from "@/api/backend";
import { pendingEntries, useChanges } from "@/features/browser/changes";
import { Button, Logo } from "@/ui";

interface State {
  error: Error | null;
  /** Where the component stack was, for the details. */
  stack: string;
  /** How many times the screen crashed since Kanopa started: Try again stops being offered at 2. */
  crashes: number;
}

/** What the crash screen says about an error, to copy into a bug report. */
export function crashDetails(error: Error, stack: string, version: string): string {
  return [`Kanopa ${version}`, `${error.name}: ${error.message}`, error.stack ?? "", stack].filter(Boolean).join("\n").trim();
}

/**
 * Catches an error thrown while the interface renders. The person gets a calm screen instead of a
 * blank window; the error goes to the log with its stack. Try again keeps pending changes (they live
 * in memory outside the screen); Reload window starts over and drops them.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, State> {
  static contextType = BackendContext;
  declare context: Backend | null;
  state: State = { error: null, stack: "", crashes: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = info.componentStack ?? "";
    this.setState((s) => ({ stack, crashes: s.crashes + 1 }));
    void this.context?.logClientError(`${error.name}: ${error.message}`, `${error.stack ?? ""}\n${stack}`).catch(() => {});
  }

  render() {
    const { error, stack, crashes } = this.state;
    if (!error) return this.props.children;
    return <CrashScreen error={error} stack={stack} canRetry={crashes < 2} onRetry={() => this.setState({ error: null })} backend={this.context} />;
  }
}

function CrashScreen({ error, stack, canRetry, onRetry, backend }: { error: Error; stack: string; canRetry: boolean; onRetry: () => void; backend: Backend | null }) {
  const pending = useChanges(pendingEntries);
  const copy = async () => {
    const about = await backend?.about().catch(() => null);
    await backend?.copyText(crashDetails(error, stack, about?.version ?? "unknown"));
  };
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-5 bg-surface p-8 text-ink" role="alert">
      <Logo size={44} wordmark />
      <div className="flex max-w-[520px] flex-col gap-2 text-center">
        <h1 className="type-title m-0">Something went wrong</h1>
        <p className="m-0 text-ink-muted">
          Kanopa hit a problem it didn&apos;t expect. Your connections and settings are safe.
          {pending > 0 &&
            ` Your ${pending} pending ${pending === 1 ? "change is" : "changes are"} kept if you try again, and dropped if you reload the window.`}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {canRetry && (
          <Button variant="primary" size="lg" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button size="lg" variant={canRetry ? "secondary" : "primary"} onClick={() => window.location.reload()}>
          {pending > 0 ? `Reload and drop ${pending} ${pending === 1 ? "change" : "changes"}` : "Reload window"}
        </Button>
        <Button size="lg" onClick={() => void copy()}>
          Copy details
        </Button>
        <Button size="lg" variant="ghost" onClick={() => void backend?.openLogFolder()}>
          Open log folder
        </Button>
      </div>
      <details className="max-w-[640px] text-ink-muted">
        <summary className="cursor-default">Details</summary>
        <pre className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-raised p-3 text-[12px] leading-4 text-ink">
          {error.name}: {error.message}
        </pre>
      </details>
    </main>
  );
}
