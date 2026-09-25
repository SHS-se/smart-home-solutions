import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';
export type { BrowserContext, Locator, Page, Request } from '@playwright/test';

// Web fonts are cosmetic but render-blocking and fetched from the public
// internet on every page load, which cost several seconds per test and made
// the mocked-backend suites depend on Google being reachable. Serve them empty
// so pages render in the fallback font straight away.
export const test = base.extend({
  context: async ({ context }, provide) => {
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: route.request().resourceType() === 'stylesheet' ? 'text/css' : 'font/woff2',
        body: '',
      }));
    await provide(context);
  },
});
