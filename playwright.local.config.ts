import { defineConfig } from '@playwright/test';
import config from './playwright.config';

// All suites with mocked backends; migration-validation requires live services.
const baseURL = 'http://127.0.0.1:4173';

export default defineConfig(config, {
  testMatch: [
    'navigation-shell.spec.ts',
    'invoice-bom-fulfillment.spec.ts',
    'plan-workbench.spec.ts',
    'replan-request.spec.ts',
  ],
  use: { baseURL },
  webServer: {
    command: 'npx vite preview --port 4173 --host 127.0.0.1 --strictPort',
    url: baseURL,
    reuseExistingServer: false,
  },
});
