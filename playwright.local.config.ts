import { defineConfig } from '@playwright/test';
import config from './playwright.config';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig(config, {
  // All mocked-backend suites available on main. The migration suite needs
  // configured live services and is deliberately run separately.
  testMatch: ['navigation-shell.spec.ts', 'invoice-bom-fulfillment.spec.ts'],
  use: { baseURL },
  webServer: {
    command: 'npx vite preview --port 4173 --host 127.0.0.1 --strictPort',
    url: baseURL,
    reuseExistingServer: false,
  },
});
