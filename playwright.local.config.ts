import { defineConfig } from '@playwright/test';
import config from './playwright.config';

// All suites with mocked backends; migration-validation requires live services.
const baseURL = 'http://127.0.0.1:4173';

export default defineConfig(config, {
  testMatch: [
    'navigation-shell.spec.ts',
    'invoice-bom-fulfillment.spec.ts',
    'replan-request.spec.ts',
    'planner-bench.spec.ts',
  ],
  // Every test builds its own context and route mocks, so tests within a file
  // are independent and can share the workers instead of running file by file.
  fullyParallel: true,
  use: {
    baseURL,
    // Keep traces and screenshots on failures; encode video only on a CI retry.
    video: process.env.CI ? 'on-first-retry' : config.use?.video,
  },
  webServer: {
    command: 'npx vite preview --port 4173 --host 127.0.0.1 --strictPort',
    url: baseURL,
    reuseExistingServer: false,
  },
});
