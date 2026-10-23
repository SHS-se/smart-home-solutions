import type { Page } from '../../playwright-fixture';

/** Read the built site's environment independently of the feature under test. */
export async function isTestWebsite(page: Page): Promise<boolean> {
  return page.getByText(/TESTMILJÖ -|TEST ENVIRONMENT -/).isVisible();
}
