import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { execSync } from "child_process";
import { checkEnvConsistency } from "./src/lib/env-consistency";

const gitCommit = (() => {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "unknown";
  }
})();

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // One env file = one environment: refuse to serve or build when the resolved
  // VITE_* vars mix test and live (e.g. test Supabase with a pk_live_ key).
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const problems = checkEnvConsistency(env);
  if (problems.length > 0) {
    throw new Error(
      `Environment configuration is inconsistent for mode "${mode}":\n  - ${problems.join("\n  - ")}`,
    );
  }

  return {
    define: {
      __GIT_COMMIT__: JSON.stringify(gitCommit),
    },
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
