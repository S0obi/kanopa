import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackendContext, type Backend } from "@/api/backend";
import { ToastRegion } from "@/ui";

/** Renders with a fresh query client, the given backend and the toast region. */
export function renderWith(ui: ReactElement, backend: Backend) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={client}>
      <BackendContext.Provider value={backend}>
        {ui}
        <ToastRegion />
      </BackendContext.Provider>
    </QueryClientProvider>,
  );
  return { user, ...result };
}
