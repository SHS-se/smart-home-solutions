import { expect, type BrowserContext, type Page, type Request } from '../../playwright-fixture';

interface GuardTarget {
  on(event: 'request', listener: (request: Request) => void): unknown;
  off(event: 'request', listener: (request: Request) => void): unknown;
}

export interface SupabaseNetworkGuard {
  assertNoViolations(): void;
  dispose(): void;
}

export function attachSupabaseNetworkGuard(
  target: BrowserContext | Page,
  allowedSupabaseUrl: string,
  blockedSupabaseUrl?: string,
): SupabaseNetworkGuard {
  const allowedHost = new URL(allowedSupabaseUrl).host;
  const blockedHost = blockedSupabaseUrl ? new URL(blockedSupabaseUrl).host : null;
  const violations: string[] = [];

  const handler = (request: Request) => {
    const url = new URL(request.url());
    if (!url.host.endsWith('.supabase.co')) {
      return;
    }

    if (blockedHost && url.host === blockedHost) {
      violations.push(`Blocked Supabase host requested: ${request.method()} ${request.url()}`);
      return;
    }

    if (url.host !== allowedHost) {
      violations.push(`Unexpected Supabase host requested: ${request.method()} ${request.url()}`);
    }
  };

  (target as GuardTarget).on('request', handler);

  return {
    assertNoViolations() {
      expect(violations, violations.join('\n')).toEqual([]);
    },
    dispose() {
      (target as GuardTarget).off('request', handler);
    },
  };
}
