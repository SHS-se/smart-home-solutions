import crypto from 'node:crypto';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function createPlusAlias(baseEmail: string, prefix: string, runId: string): string {
  const atIndex = baseEmail.indexOf('@');
  if (atIndex === -1) {
    throw new Error(`E2E mailbox address must be an email address: ${baseEmail}`);
  }

  const localPart = baseEmail.slice(0, atIndex);
  const domain = baseEmail.slice(atIndex + 1);
  return `${localPart}+${prefix}-${runId}@${domain}`;
}

export interface E2EConfig {
  baseURL: string;
  allowedSupabaseUrl?: string;
  blockedSupabaseUrl?: string;
  staffEmail: string;
  staffPassword: string;
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
    mailbox: string;
  };
  mailboxAddress: string;
  mailboxAliasPrefix: string;
  fixedCustomerEmail?: string;
}

export interface RunContext {
  runId: string;
  customerEmail: string;
  customerPassword: string;
  customerName: string;
  customerPhone: string;
  projectName: string;
  siteStreet: string;
  sitePostcode: string;
  siteCity: string;
  customerId?: string;
  bomId?: string;
  latestQuoteId?: string;
  latestQuoteLink?: string;
  latestInvoiceUrl?: string;
  initialSkuCodes: string[];
  revisedSkuCode?: string;
}

export function loadE2EConfig(): E2EConfig {
  const baseURL = process.env.E2E_BASE_URL || process.env.PLAYWRIGHT_BASE_URL;
  if (!baseURL) {
    throw new Error('Missing required environment variable: E2E_BASE_URL');
  }

  const imapUser = requireEnv('E2E_IMAP_USER');
  const fixedCustomerEmail = process.env.E2E_CUSTOMER_EMAIL?.trim();
  const mailboxAddress = process.env.E2E_MAILBOX_ADDRESS || (imapUser.includes('@') ? imapUser : '');
  if (!fixedCustomerEmail && !mailboxAddress) {
    throw new Error(
      'Missing E2E_MAILBOX_ADDRESS. It can be omitted when E2E_IMAP_USER is the mailbox email address or when E2E_CUSTOMER_EMAIL is set.',
    );
  }

  const inferredImapHost =
    process.env.E2E_IMAP_HOST || (imapUser.toLowerCase().endsWith('@gmail.com') ? 'imap.gmail.com' : '');
  if (!inferredImapHost) {
    throw new Error(
      'Missing required environment variable: E2E_IMAP_HOST. This can be omitted for Gmail accounts.',
    );
  }

  return {
    baseURL,
    allowedSupabaseUrl: process.env.E2E_ALLOWED_SUPABASE_URL,
    blockedSupabaseUrl: process.env.E2E_BLOCKED_SUPABASE_URL,
    staffEmail: requireEnv('E2E_STAFF_EMAIL'),
    staffPassword: requireEnv('E2E_STAFF_PASSWORD'),
    imap: {
      host: inferredImapHost,
      port: Number(process.env.E2E_IMAP_PORT || 993),
      user: imapUser,
      password: requireEnv('E2E_IMAP_PASS'),
      tls: parseBoolean(process.env.E2E_IMAP_TLS, true),
      mailbox: process.env.E2E_IMAP_MAILBOX || 'INBOX',
    },
    mailboxAddress,
    mailboxAliasPrefix: process.env.E2E_MAILBOX_ALIAS_PREFIX || 'e2e-migration',
    fixedCustomerEmail,
  };
}

export function createRunContext(config: E2EConfig): RunContext {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const runId = `${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
  const suffix = runId.slice(-6).toUpperCase();
  const phoneDigits = timestamp.slice(-7);

  return {
    runId,
    customerEmail:
      config.fixedCustomerEmail || createPlusAlias(config.mailboxAddress, config.mailboxAliasPrefix, runId),
    customerPassword: process.env.E2E_CUSTOMER_PASSWORD || `Shs!${suffix}9`,
    customerName: `E2E Migration ${suffix}`,
    customerPhone: `070${phoneDigits}`,
    projectName: `E2E BOM ${suffix}`,
    siteStreet: `Migrationgatan ${suffix.slice(0, 3)}`,
    sitePostcode: '183 57',
    siteCity: 'Taby',
    initialSkuCodes: [],
  };
}
