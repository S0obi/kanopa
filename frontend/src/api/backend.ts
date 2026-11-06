import { createContext, useContext } from "react";
import type { ConnectionParams, TestResult } from "../../bindings/github.com/S0obi/kanopa/services/models";

export type { ConnectionParams, TestResult };

/**
 * Everything the UI asks of the Go side. The app uses the Wails bindings;
 * Vitest and Playwright use the fake backend (src/api/fake.ts).
 */
export interface Backend {
  testConnection(p: ConnectionParams, signal?: AbortSignal): Promise<TestResult>;
  fetchBaseDn(p: ConnectionParams, signal?: AbortSignal): Promise<TestResult>;
}

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error("useBackend needs a BackendContext provider");
  return b;
}
