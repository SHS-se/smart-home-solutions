import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from '../playwright-fixture';
import { createRunContext, loadE2EConfig, type E2EConfig, type RunContext } from './helpers/env';
import { attachSupabaseNetworkGuard, type SupabaseNetworkGuard } from './helpers/network-guard';
import { pickFirstLink, waitForEmail } from './helpers/mail';

interface SavedHomeAnswer {
  questionId: string;
  questionType: string;
  expectedText?: string;
  expectedNumber?: string;
}

let config: E2EConfig;
let run: RunContext;
let staffContext: BrowserContext;
let customerContext: BrowserContext;
let publicContext: BrowserContext;
let staffPage: Page;
let customerPage: Page;
let publicPage: Page;
let guards: SupabaseNetworkGuard[] = [];

function createGuardForContext(context: BrowserContext): SupabaseNetworkGuard | null {
  if (!config.allowedSupabaseUrl && !config.blockedSupabaseUrl) {
    return null;
  }

  return attachSupabaseNetworkGuard(context, config.allowedSupabaseUrl, config.blockedSupabaseUrl);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseUrlId(url: string, pattern: RegExp): string {
  const match = url.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not extract identifier from URL: ${url}`);
  }
  return match[1];
}

function expectAppOrigin(link: string, label: string): void {
  // Soft assertion: records a failure in CI without stopping the test locally.
  // The link origin is determined by Supabase's "Site URL" config, which differs
  // across prod/test/local. We rewrite it for navigation (see rewriteToAppOrigin),
  // but still flag a mismatch so misconfiguration is visible in reports.
  expect.soft(new URL(link).origin, `${label} link should point at the configured frontend origin`).toBe(
    new URL(config.baseURL).origin,
  );
}

/**
 * Rewrites the origin of a Supabase-generated link to the configured frontend
 * origin so that local/test/prod runs all navigate to the correct host.
 * The path and query (including the auth token/code) are preserved unchanged.
 */
function rewriteToAppOrigin(link: string): string {
  const url = new URL(link);
  const appUrl = new URL(config.baseURL);
  url.protocol = appUrl.protocol;
  url.host = appUrl.host;
  return url.toString();
}

async function clickRadixOption(page: Page, trigger: Locator, optionText: string): Promise<void> {
  await trigger.click();

  const option = page.getByRole('option', { name: optionText, exact: true });
  if (await option.count()) {
    await option.click();
    return;
  }

  await page.getByText(optionText, { exact: true }).last().click();
}

async function ensureStaffLoggedIn(page: Page): Promise<void> {
  // /login may immediately redirect to /portal if already authenticated.
  // Treat “we got to /portal” as “we’re logged in”. Do NOT hang for 15 minutes.
  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');

  const emailField = page.getByRole('textbox', { name: /e-postadress|email/i }).first();
  const passwordField = page.getByLabel(/lösenord|password/i).first();

  // Wait for either:
  // - redirect to /portal (already logged in)
  // - login form becomes visible (need to log in)
  await Promise.race([
    page.waitForURL(/\/portal(?:\/|$)/, { timeout: 60_000 }).catch(() => null),
    emailField.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => null),
  ]);

  if (/\/portal(?:\/|$)/.test(page.url())) {
    return;
  }

  // If we’re still on /login, do the login flow.
  await emailField.fill(config.staffEmail);
  await passwordField.fill(config.staffPassword);
  await page.getByRole('button', { name: /logga in|log in/i }).click();

  await page.waitForURL(/\/portal(?:\/|$)/, { timeout: 60_000 });
  await expect(page).not.toHaveURL(/\/login$/);
}

async function ensureStaffOnContacts(page: Page): Promise<Locator> {
  await ensureStaffLoggedIn(page);

  await page.goto('/portal/contacts');
  await page.waitForURL(/\/portal\/contacts(?:\/|$)/);

  const search = page.locator('input[placeholder*="kontakter"], input[placeholder*="contacts"]');
  await expect(search.first()).toBeVisible({ timeout: 30_000 });
  return search.first();
}

async function submitContactLead(page: Page): Promise<void> {
  await page.goto('/contact');
  await page.locator('#name').fill(run.customerName);
  await page.locator('#phone').fill(run.customerPhone);
  await page.locator('#email').fill(run.customerEmail);
  await page
    .locator('#message')
    .fill(`Migration validation request ${run.runId}. Please create a customer portal account.`);

  await page.getByRole('button', { name: /skicka meddelande|send message/i }).click();
  await expect(
    page.getByText(/Vill du spara tid|Tack för ditt meddelande|Thank you for your message/i),
  ).toBeVisible();
}

async function completeSignupFromInvite(page: Page, verifyLink: string): Promise<void> {
  expectAppOrigin(verifyLink, 'Verification');

  await page.goto(rewriteToAppOrigin(verifyLink));
  // Match only the customer-portal home-profile path, NOT the staff customer-view variant.
  await page.waitForURL(/\/onboarding\/set-password|\/portal\/home-profile(?:\?|$)/, { timeout: 60_000 });

  if (/\/onboarding\/set-password/.test(page.url())) {
    await page.locator('#password').fill(run.customerPassword);
    await page.locator('#confirmPassword').fill(run.customerPassword);
    await page.getByRole('button', { name: /spara lösenord|save password/i }).click();
  }

  await page.waitForURL(/\/portal\/home-profile(?:\?|$)/, { timeout: 60_000 });
}

async function updateCustomerAccount(page: Page): Promise<void> {
  await page.goto('/portal/account');
  // Wait for the auth context to finish loading and populate the form.
  // The #name field transitions from '' → customer name once customerData arrives.
  // Filling before this fires gets overwritten by the useEffect, so we wait first.
  await expect(page.locator('#name')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#name')).not.toHaveValue('', { timeout: 15_000 });
  await page.locator('#name').fill(run.customerName);
  await page.locator('#email').fill(run.customerEmail);
  await page.locator('#phone').fill(run.customerPhone);
  await page.locator('#site_street').fill(run.siteStreet);
  await page.locator('#site_postcode').fill(run.sitePostcode);
  await page.locator('#site_city').fill(run.siteCity);
  // Intercept Supabase REST calls to detect if the save PATCH fires at all and what it returns.
  const patchRequests: { url: string; status: number; body: string }[] = [];
  const responseListener = async (resp: import('@playwright/test').Response) => {
    if (resp.url().includes('/rest/v1/customers') && resp.request().method() === 'PATCH') {
      const body = await resp.text().catch(() => '');
      patchRequests.push({ url: resp.url(), status: resp.status(), body });
    }
  };
  page.on('response', responseListener);

  await page.getByTestId('account-save-button').click();

  // Wait for saving state to clear (button re-enabled means handleSave finished, even if it returned early)
  await expect(page.getByTestId('account-save-button')).toBeEnabled({ timeout: 15_000 });

  page.off('response', responseListener);

  // Fail early if save didn't fire at all (resolvedCustomerId was null) or returned an error
  if (patchRequests.length === 0) {
    throw new Error('Account save did not issue a PATCH to /rest/v1/customers — resolvedCustomerId was likely null (auth not loaded yet)');
  }
  const failedPatch = patchRequests.find(r => r.status >= 300);
  if (failedPatch) {
    throw new Error(`Account save PATCH failed: HTTP ${failedPatch.status} — ${failedPatch.body}`);
  }

  await page.reload();
  await expect(page.locator('#name')).toHaveValue(run.customerName);
  await expect(page.locator('#email')).toHaveValue(run.customerEmail);
  await expect(page.locator('#site_street')).toHaveValue(run.siteStreet);
  await expect(page.locator('#site_postcode')).toHaveValue(run.sitePostcode);
  await expect(page.locator('#site_city')).toHaveValue(run.siteCity);
}

async function answerFirstHomeProfileQuestion(page: Page): Promise<SavedHomeAnswer> {
  await expect(async () => {
    await page.goto('/portal/home-profile');
    await expect(page).toHaveURL(/\/portal\/home-profile(?:\?|$)/, { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });

  // Wait for the actual Home Profile page title (h1), not the dashboard card heading.
  await expect(page.getByRole('heading', { name: /hemprofil|home profile/i, level: 1 })).toBeVisible({
    timeout: 60_000,
  });

  const firstQuestion = page.getByTestId('home-profile-question').first();
  const noQuestions = page.getByTestId('home-profile-no-questions').first();

  // Wait up to 60s for either a question to load or an explicit empty-state.
  await Promise.race([
    expect(firstQuestion).toBeVisible({ timeout: 60_000 }),
    expect(noQuestions).toBeVisible({ timeout: 60_000 }),
  ]);

  if (await noQuestions.isVisible().catch(() => false)) {
    throw new Error('Home profile has no questions configured (data-testid=home-profile-no-questions).');
  }

  const question = firstQuestion;
  const questionId = await question.getAttribute('data-question-id');
  const questionType = await question.getAttribute('data-question-type');

  if (!questionId || !questionType) {
    throw new Error('Home profile question metadata is missing');
  }

  if (questionType === 'boolean') {
    await question.getByRole('switch').click();
  } else if (questionType === 'number') {
    await question.locator('input[type="number"]').fill('2');
  } else if (questionType === 'single_choice') {
    await question.getByRole('radio').first().click();
  } else if (questionType === 'multi_choice') {
    await question.getByRole('checkbox').first().click();
  } else {
    const answer = `Migration home note ${run.runId}`;
    const textInput = question.locator('textarea, input').first();
    await textInput.fill(answer);
  }

  await page.getByTestId('home-profile-save-button').click();
  await expect(page.getByTestId('home-profile-save-button')).toBeEnabled({ timeout: 15_000 });

  if (questionType === 'number') {
    return { questionId, questionType, expectedNumber: '2' };
  }
  if (questionType === 'text') {
    return {
      questionId,
      questionType,
      expectedText: `Migration home note ${run.runId}`,
    };
  }
  return { questionId, questionType };
}

async function verifyHomeProfileAnswerPersists(page: Page, saved: SavedHomeAnswer): Promise<void> {
  await page.reload();

  const question = page
    .locator(`[data-testid="home-profile-question"][data-question-id="${saved.questionId}"]`)
    .first();
  await expect(question).toBeVisible();

  if (saved.questionType === 'boolean') {
    await expect(question.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    return;
  }

  if (saved.questionType === 'number') {
    await expect(question.locator('input[type="number"]')).toHaveValue(saved.expectedNumber ?? '2');
    return;
  }

  if (saved.questionType === 'single_choice') {
    await expect(question.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
    return;
  }

  if (saved.questionType === 'multi_choice') {
    await expect(question.getByRole('checkbox').first()).toHaveAttribute('aria-checked', 'true');
    return;
  }

  await expect(question.locator('textarea, input').first()).toHaveValue(saved.expectedText ?? '');
}

async function createBomForCustomer(page: Page): Promise<void> {
  await page.goto('/portal/boms');
  await page.getByTestId('bom-create-button').click();
  await page.getByTestId('bom-project-name-input').fill(run.projectName);
  await page.getByTestId('bom-create-submit-button').click();
  await page.waitForURL(/\/portal\/boms\/[^/]+$/);

  run.bomId = parseUrlId(page.url(), /\/portal\/boms\/([^/?#]+)/);

  await clickRadixOption(page, page.getByTestId('bom-customer-trigger'), run.customerName);
  await expect(page.getByTestId('bom-customer-trigger')).toContainText(run.customerName);
}

async function addAvailableSkus(page: Page, count: number): Promise<string[]> {
  await page.getByTestId('bom-add-sku-button').click();
  const dialog = page.getByRole('dialog', { name: /Välj SKU|Select SKU/i });
  await expect(dialog).toBeVisible();

  const selectedCodes: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const addButtons = dialog.getByTestId('sku-selector-add-button');
    const beforeCount = await addButtons.count();
    if (beforeCount === 0) {
      throw new Error(`Only ${selectedCodes.length} selectable SKUs were available`);
    }

    const button = addButtons.first();
    const row = button.locator('xpath=ancestor::tr[1]');
    const code = await row.getAttribute('data-sku-code');
    if (!code) {
      throw new Error('Selectable SKU row is missing data-sku-code');
    }

    selectedCodes.push(code);
    await button.click();
    await expect(dialog.getByTestId('sku-selector-add-button')).toHaveCount(beforeCount - 1);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return selectedCodes;
}

async function createQuoteFromBom(page: Page): Promise<void> {
  await Promise.all([
    page.waitForURL(/\/portal\/quotes\/[^/]+$/),
    page.getByTestId('bom-create-quote-button').click(),
  ]);

  run.latestQuoteId = parseUrlId(page.url(), /\/portal\/quotes\/([^/?#]+)/);
}

async function sendQuoteAndOpenPublicLink(page: Page, afterIso: string): Promise<string> {
  expect(run.latestQuoteId, 'Latest quote ID is missing before sending quote email').toBeTruthy();

  await page.getByTestId('quote-send-email-button').click();

  const quoteEmail = await waitForEmail(config, {
    recipient: run.customerEmail,
    afterIso,
    subjectIncludes: ['Offert '],
    timeoutMs: 180_000,
  });

  const publicQuoteLink = pickFirstLink(
    quoteEmail,
    (link) => link.includes(`/portal/quote/${run.latestQuoteId}`),
    'public quote',
  );
  expectAppOrigin(publicQuoteLink, 'Quote');
  console.log('[e2e] quote email subject:', quoteEmail.subject);
  console.log('[e2e] public quote link:', publicQuoteLink);
  return publicQuoteLink;
}

async function requestQuoteRevision(page: Page, quoteLink: string): Promise<void> {
  await page.goto(rewriteToAppOrigin(quoteLink));
  await expect(page.getByTestId('public-quote-request-revision-button')).toBeVisible();
  await page.getByTestId('public-quote-request-revision-button').click();
  await page
    .getByTestId('public-quote-revision-message')
    .fill(`Please add one more SKU before we approve this quote. Run ${run.runId}.`);
  await page.getByTestId('public-quote-request-revision-confirm-button').click();
  await expect(page.getByText(/Ändringsförfrågan skickad|revision requested/i)).toBeVisible();
}

async function createBomRevisionAndReissueQuote(page: Page): Promise<string> {
  expect(run.bomId, 'BOM ID from the initial quote flow is missing').toBeTruthy();

  await expect(async () => {
    await page.goto(`/portal/boms/${run.bomId}`);
    await page.reload();
    await expect(page.getByTestId('bom-create-revision-button')).toBeEnabled();
  }).toPass({ timeout: 120_000 });

  await page.getByTestId('bom-create-revision-button').click();
  await clickRadixOption(page, page.getByTestId('bom-revision-reason-trigger'), 'Kundönskemål (portal)');
  await page.getByTestId('bom-create-revision-submit-button').click();
  await page.waitForURL(/\/portal\/boms\/[^/]+$/);

  run.bomId = parseUrlId(page.url(), /\/portal\/boms\/([^/?#]+)/);
  const [revisedSkuCode] = await addAvailableSkus(page, 1);
  run.revisedSkuCode = revisedSkuCode;

  await expect(page.getByText(revisedSkuCode, { exact: true })).toBeVisible();
  await createQuoteFromBom(page);

  const secondSendStartedAt = nowIso();
  const publicQuoteLink = await sendQuoteAndOpenPublicLink(page, secondSendStartedAt);
  run.latestQuoteLink = publicQuoteLink;
  return publicQuoteLink;
}

async function acceptUpdatedQuote(page: Page, quoteLink: string): Promise<void> {
  await page.goto(rewriteToAppOrigin(quoteLink));
  await page.getByTestId('public-quote-accept-button').click();
  await page.getByTestId('public-quote-accept-confirm-button').click();
  await expect(page.getByText(/Offerten är godkänd|quote is accepted/i)).toBeVisible();
}

async function waitForQuoteToBecomeAccepted(page: Page): Promise<void> {
  expect(run.latestQuoteId, 'Latest quote ID is missing').toBeTruthy();

  await expect(async () => {
    await page.goto(`/portal/quotes/${run.latestQuoteId}`);
    await page.reload();
    await expect(page.getByTestId('quote-create-invoice-button')).toBeEnabled();
  }).toPass({ timeout: 180_000 });
}

async function createFinalizeAndSendInvoice(page: Page): Promise<string> {
  await page.getByTestId('quote-create-invoice-button').click();
  await page.waitForURL(/\/portal\/invoices\/new\?id=/);
  await expect(page.getByTestId('invoice-finalize-button')).toBeVisible();

  await Promise.all([
    page.waitForURL(/\/portal\/invoices\/(?!new(?:[/?#]|$))[^/?#]+(?:[?#].*)?$/),
    page.getByTestId('invoice-finalize-button').click(),
  ]);

  run.latestInvoiceUrl = page.url();
  console.log('[e2e] finalized invoice detail url:', run.latestInvoiceUrl);

  const invoiceEmailStartedAt = nowIso();
  await page.getByTestId('invoice-send-email-button').click();
  await expect(page.getByTestId('invoice-email-send-button')).toBeVisible();
  await page.getByTestId('invoice-email-send-button').click();

  const invoiceEmail = await waitForEmail(config, {
    recipient: run.customerEmail,
    afterIso: invoiceEmailStartedAt,
    subjectIncludes: ['Faktura '],
    timeoutMs: 180_000,
  });

  const publicInvoiceLink = pickFirstLink(
    invoiceEmail,
    (link) => link.includes('/portal/invoice/') && !link.toLowerCase().includes('/pdf'),
    'public invoice',
  );
  console.log('[e2e] invoice email subject:', invoiceEmail.subject);
  console.log('[e2e] public invoice link:', publicInvoiceLink);
  return publicInvoiceLink;
}

async function openPublicInvoiceAndVerify(page: Page, invoiceLink: string): Promise<void> {
  await page.goto(rewriteToAppOrigin(invoiceLink));
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText(/Faktura TIN-|Faktura IN-/i)).toBeVisible();
  await expect(page.getByText(/Betalningsinformation/i)).toBeVisible();
  await expect(page.getByText(/Betalningsreferens:/i)).toBeVisible();
}

async function recordInvoicePayment(page: Page): Promise<void> {
  await expect(page.getByTestId('invoice-record-payment-button')).toBeVisible();
  await page.getByTestId('invoice-record-payment-button').click();

  const dialog = page.getByTestId('invoice-record-payment-dialog');
  const amountInput = page.getByTestId('invoice-payment-amount-input');

  await expect(dialog).toBeVisible();
  await expect(amountInput).toBeVisible();
  await expect(amountInput).not.toHaveValue('');

  await page.getByTestId('invoice-payment-save-button').click();
  await expect(dialog).toBeHidden();
}

async function waitForInvoicePaid(page: Page): Promise<void> {
  expect(run.latestInvoiceUrl, 'Invoice detail URL is missing').toBeTruthy();

  await expect(async () => {
    await page.goto(run.latestInvoiceUrl!);
    await page.reload();
    await expect(page.getByTestId('invoice-paid-indicator')).toBeVisible();
  }).toPass({ timeout: 180_000 });
}

test.describe.serial('Migration validation UI', () => {
  test.beforeAll(async ({ browser }) => {
    config = loadE2EConfig();
    run = createRunContext(config);

    const contextOptions = {
      ignoreHTTPSErrors: true,
      locale: 'sv-SE',
      timezoneId: 'Europe/Stockholm',
    } as const;

    staffContext = await browser.newContext(contextOptions);
    customerContext = await browser.newContext(contextOptions);
    publicContext = await browser.newContext(contextOptions);

    guards = [
      createGuardForContext(staffContext),
      createGuardForContext(customerContext),
      createGuardForContext(publicContext),
    ].filter((guard): guard is SupabaseNetworkGuard => guard !== null);

    staffPage = await staffContext.newPage();
    customerPage = await customerContext.newPage();
    publicPage = await publicContext.newPage();
  });

  test.afterAll(async () => {
    for (const guard of guards) {
      guard.assertNoViolations();
      guard.dispose();
    }

    await Promise.all([
      publicContext?.close(),
      customerContext?.close(),
      staffContext?.close(),
    ]);
  });

  test('test 1: signup and customer home profile survive the Supabase migration', async () => {
    const inviteEmailStartedAt = nowIso();
    await submitContactLead(customerPage);

    const inviteEmail = await waitForEmail(config, {
      recipient: run.customerEmail,
      afterIso: inviteEmailStartedAt,
      subjectIncludes: ['Fyll i din hemprofil'],
      timeoutMs: 180_000,
    });

    const verifyLink = pickFirstLink(inviteEmail, (link) => link.includes('/verify?code='), 'verification');
    console.log('[e2e] invite email subject:', inviteEmail.subject);
    console.log('[e2e] verify link:', verifyLink);
    await completeSignupFromInvite(customerPage, verifyLink);
    await updateCustomerAccount(customerPage);

    const savedAnswer = await answerFirstHomeProfileQuestion(customerPage);
    await verifyHomeProfileAnswerPersists(customerPage, savedAnswer);
  });

  test('test 2: bom, quote revision, invoice and payment survive the Supabase migration', async () => {
    await ensureStaffLoggedIn(staffPage);
    await createBomForCustomer(staffPage);

    run.initialSkuCodes = await addAvailableSkus(staffPage, 2);
    for (const skuCode of run.initialSkuCodes) {
      await expect(staffPage.getByText(skuCode, { exact: false })).toBeVisible();
    }

    await createQuoteFromBom(staffPage);

    const firstQuoteEmailStartedAt = nowIso();
    const firstQuoteLink = await sendQuoteAndOpenPublicLink(staffPage, firstQuoteEmailStartedAt);
    await requestQuoteRevision(publicPage, firstQuoteLink);

    const updatedQuoteLink = await createBomRevisionAndReissueQuote(staffPage);
    await acceptUpdatedQuote(publicPage, updatedQuoteLink);

    await waitForQuoteToBecomeAccepted(staffPage);

    const publicInvoiceLink = await createFinalizeAndSendInvoice(staffPage);
    await openPublicInvoiceAndVerify(publicPage, publicInvoiceLink);
    await recordInvoicePayment(staffPage);
    await waitForInvoicePaid(staffPage);
  });
});
