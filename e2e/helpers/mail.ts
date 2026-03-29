import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { E2EConfig } from './env';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imapScriptPath = path.resolve(__dirname, '../bin/imap_poll.py');

export interface PolledEmail {
  subject: string;
  date: string;
  from: string[];
  to: string[];
  links: string[];
  text: string;
  html: string;
}

export interface WaitForEmailOptions {
  recipient: string;
  afterIso: string;
  subjectIncludes?: string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function waitForEmail(
  config: E2EConfig,
  options: WaitForEmailOptions,
): Promise<PolledEmail> {
  const args = [
    imapScriptPath,
    '--recipient',
    options.recipient,
    '--after',
    options.afterIso,
    '--timeout-seconds',
    String(Math.ceil((options.timeoutMs ?? 180_000) / 1000)),
    '--poll-seconds',
    String(Math.ceil((options.pollIntervalMs ?? 5_000) / 1000)),
    '--mailbox',
    config.imap.mailbox,
  ];

  for (const subject of options.subjectIncludes ?? []) {
    args.push('--subject', subject);
  }

  const { stdout, stderr } = await execFileAsync('python3', args, {
    env: {
      ...process.env,
      IMAP_HOST: config.imap.host,
      IMAP_PORT: String(config.imap.port),
      IMAP_USER: config.imap.user,
      IMAP_PASS: config.imap.password,
      IMAP_TLS: String(config.imap.tls),
    },
    maxBuffer: 2 * 1024 * 1024,
  });

  if (stderr?.trim()) {
    throw new Error(stderr.trim());
  }

  return JSON.parse(stdout) as PolledEmail;
}

export function pickFirstLink(
  email: PolledEmail,
  matcher: (link: string) => boolean,
  label: string,
): string {
  const link = email.links.find(matcher);
  if (!link) {
    throw new Error(`Could not find ${label} link in email with subject "${email.subject}"`);
  }
  return link;
}
