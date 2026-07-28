import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const preloadRecoveryKey = `vite-preload-recovery:${__GIT_COMMIT__}`;
const maxPreloadRecoveryAttempts = 3;
const preloadRecoveryResetMs = 30_000;
let preloadRecoveryScheduled = false;

function resetPreloadRecovery(): void {
  sessionStorage.removeItem(preloadRecoveryKey);
}

const preloadRecoveryResetTimer = window.setTimeout(
  resetPreloadRecovery,
  preloadRecoveryResetMs,
);

window.addEventListener("vite:preloadError", () => {
  if (preloadRecoveryScheduled) return;
  window.clearTimeout(preloadRecoveryResetTimer);
  const storedAttempts = Number.parseInt(
    sessionStorage.getItem(preloadRecoveryKey) ?? "0",
    10,
  );
  const attempts = Number.isFinite(storedAttempts) ? storedAttempts : 0;

  if (attempts >= maxPreloadRecoveryAttempts) {
    return;
  }

  preloadRecoveryScheduled = true;
  sessionStorage.setItem(preloadRecoveryKey, String(attempts + 1));
  window.setTimeout(
    () => window.location.reload(),
    750 * (2 ** attempts),
  );
});

interface FatalErrorBoundaryProps {
  children: ReactNode;
}

interface FatalErrorBoundaryState {
  error: Error | null;
}

class FatalErrorBoundary extends Component<
  FatalErrorBoundaryProps,
  FatalErrorBoundaryState
> {
  state: FatalErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): FatalErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Application render failed:", error, info);
  }

  private reload = (): void => {
    resetPreloadRecovery();
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-lg rounded-xl border border-border bg-card p-6 text-center shadow-sm">
          <h1 className="text-xl font-semibold">
            Sidan kunde inte laddas / The page could not be loaded
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            En ny version kan ha publicerats. Ladda om sidan för att fortsätta.
            <br />
            A new version may have been published. Reload the page to continue.
          </p>
          <button
            type="button"
            className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            onClick={this.reload}
          >
            Ladda om / Reload
          </button>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <FatalErrorBoundary>
    <App />
  </FatalErrorBoundary>,
);
