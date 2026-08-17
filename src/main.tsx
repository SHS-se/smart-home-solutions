import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import {
  armPreloadRecovery,
  isRecoveryScheduled,
  reloadWithFreshDocument,
  resetPreloadRecovery,
} from "@/lib/app-recovery";

armPreloadRecovery();

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
    reloadWithFreshDocument(`manual-${Date.now()}`);
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
            {isRecoveryScheduled()
              ? "En ny version hämtas. Sidan försöker automatiskt igen."
              : "En ny version kan ha publicerats. Ladda om sidan för att fortsätta."}
            <br />
            {isRecoveryScheduled()
              ? "A new version is being fetched. The page will retry automatically."
              : "A new version may have been published. Reload the page to continue."}
          </p>
          <button
            type="button"
            className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            onClick={this.reload}
          >
            Försök nu / Retry now
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
