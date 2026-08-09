// Central navigation configuration — the single source of truth for every
// navigation surface in the app (public header, customer portal sidebar,
// staff sidebar, staff customer-view sidebar).
//
// Pure data + pure helpers only (no React, no JSX, no runtime deps) so the
// structure can be unit-tested with `deno test`.

export type NavIcon =
  | 'overview'
  | 'home-profile'
  | 'energy-history'
  | 'energy'
  | 'offers'
  | 'billing'
  | 'tickets'
  | 'account'
  | 'customers'
  | 'contacts'
  | 'quotes'
  | 'invoices'
  | 'boms'
  | 'skus'
  | 'templates'
  | 'devices'
  | 'acc-overview'
  | 'acc-periods'
  | 'acc-journal'
  | 'acc-purchases'
  | 'acc-suppliers'
  | 'acc-sales'
  | 'acc-receivables'
  | 'acc-payments'
  | 'acc-vat'
  | 'acc-integrity'
  | 'margins'
  | 'business'
  | 'questionnaire'
  | 'tariffs'
  | 'erd'
  | 'staff';

export interface AppNavItem {
  path: string;
  labelSv: string;
  labelEn: string;
  icon: NavIcon;
  /** Secondary destinations rendered beneath the active sidebar item. */
  subItems?: AppNavSubItem[];
  /** Only highlight on an exact path match (for overview/index items). */
  end?: boolean;
  /** Additional paths that should highlight this item (e.g. route aliases). */
  aliases?: string[];
  /** Only show this item to admin staff (e.g. staff account management). */
  adminOnly?: boolean;
}

export interface AppNavSubItem {
  path: string;
  labelSv: string;
  labelEn: string;
  /** Match this item when the page is opened without an explicit query value. */
  default?: boolean;
}

export interface AppNavGroup {
  id: string;
  /** null = ungrouped items rendered without a heading. */
  labelSv: string | null;
  labelEn: string | null;
  items: AppNavItem[];
  /** Large groups can collapse in the sidebar. */
  collapsible?: boolean;
}

export interface PublicNavItem {
  path: string;
  labelSv: string;
  labelEn: string;
}

/** Public marketing navigation (guests and the public header). */
export const publicNavItems: PublicNavItem[] = [
  { path: '/services', labelSv: 'Tjänster', labelEn: 'Services' },
  { path: '/knowledge', labelSv: 'Kunskapscenter', labelEn: 'Knowledge' },
  { path: '/about', labelSv: 'Om oss', labelEn: 'About' },
];

export const CUSTOMER_PORTAL_BASE = '/portal';
export const CUSTOMER_VIEW_BASE = '/portal/customers';

/** Base path for the staff customer-view of one specific customer. */
export function getCustomerViewBasePath(customerId: string): string {
  return `${CUSTOMER_VIEW_BASE}/${customerId}`;
}

/**
 * Customer portal navigation. Used both for real logged-in customers
 * (basePath = '/portal') and for staff viewing one customer's portal
 * (basePath = '/portal/customers/:customerId').
 */
export function getCustomerNavItems(basePath: string = CUSTOMER_PORTAL_BASE): AppNavItem[] {
  const isCustomerView = basePath !== CUSTOMER_PORTAL_BASE;
  const overviewPath = isCustomerView ? `${basePath}/overview` : basePath;
  return [
    { path: overviewPath, labelSv: 'Översikt', labelEn: 'Overview', icon: 'overview', end: true },
    { path: `${basePath}/home-profile`, labelSv: 'Hemprofil', labelEn: 'Home profile', icon: 'home-profile' },
    {
      path: `${basePath}/energy-history`,
      labelSv: 'Energihistorik',
      labelEn: 'Energy history',
      icon: 'energy-history',
      subItems: [
        {
          path: `${basePath}/energy-history?tab=overview`,
          labelSv: 'Översikt',
          labelEn: 'Overview',
          default: true,
        },
        {
          path: `${basePath}/energy-history?tab=data`,
          labelSv: 'Data',
          labelEn: 'Data',
        },
        {
          path: `${basePath}/energy-history?tab=temperature`,
          labelSv: 'Temperatur',
          labelEn: 'Temperature',
        },
        {
          path: `${basePath}/energy-history?tab=performance`,
          labelSv: 'Energiprestanda',
          labelEn: 'Performance',
        },
      ],
    },
    { path: `${basePath}/energy-modeling`, labelSv: 'Energimodellering', labelEn: 'Energy modeling', icon: 'energy' },
    { path: `${basePath}/offers`, labelSv: 'Offerter', labelEn: 'Offers', icon: 'offers' },
    { path: `${basePath}/billing`, labelSv: 'Fakturor', labelEn: 'Billing', icon: 'billing' },
    { path: `${basePath}/tickets`, labelSv: 'Ärenden', labelEn: 'Tickets', icon: 'tickets' },
    { path: `${basePath}/account`, labelSv: 'Konto', labelEn: 'Account', icon: 'account' },
  ];
}

export function getCustomerNavGroups(basePath: string = CUSTOMER_PORTAL_BASE): AppNavGroup[] {
  return [
    {
      id: 'customer-portal',
      labelSv: null,
      labelEn: null,
      items: getCustomerNavItems(basePath),
    },
  ];
}

/** Global staff navigation, grouped by area. Accounting is one group here —
 *  part of the staff app, not a separate product. */
export const staffNavGroups: AppNavGroup[] = [
  {
    id: 'staff-home',
    labelSv: null,
    labelEn: null,
    items: [
      { path: '/portal', labelSv: 'Översikt', labelEn: 'Overview', icon: 'overview', end: true },
    ],
  },
  {
    id: 'crm',
    labelSv: 'CRM',
    labelEn: 'CRM',
    items: [
      // `end` keeps Kunder from highlighting on /portal/customers/:id (customer view)
      // and /portal/customers/questionnaire (administration).
      { path: '/portal/customers', labelSv: 'Kunder', labelEn: 'Customers', icon: 'customers', end: true },
      { path: '/portal/contacts', labelSv: 'Kontakter', labelEn: 'Contacts', icon: 'contacts' },
      { path: '/portal/tickets', labelSv: 'Ärenden', labelEn: 'Tickets', icon: 'tickets' },
    ],
  },
  {
    id: 'sales',
    labelSv: 'Försäljning',
    labelEn: 'Sales',
    items: [
      { path: '/portal/quotes', labelSv: 'Offerter', labelEn: 'Quotes', icon: 'quotes' },
      { path: '/portal/invoices', labelSv: 'Fakturor', labelEn: 'Invoices', icon: 'invoices' },
      { path: '/portal/boms', labelSv: 'Materiallistor', labelEn: 'BOMs', icon: 'boms' },
    ],
  },
  {
    id: 'catalog',
    labelSv: 'Katalog',
    labelEn: 'Catalog',
    items: [
      { path: '/portal/skus', labelSv: 'SKU-katalog', labelEn: 'SKU catalog', icon: 'skus' },
      { path: '/portal/templates', labelSv: 'Mallpaket', labelEn: 'Templates', icon: 'templates' },
      { path: '/portal/device-catalog', labelSv: 'Enhetskatalog', labelEn: 'Device catalog', icon: 'devices' },
    ],
  },
  {
    id: 'accounting',
    labelSv: 'Bokföring',
    labelEn: 'Accounting',
    collapsible: true,
    items: [
      { path: '/accounting/overview', labelSv: 'Ekonomiöversikt', labelEn: 'Overview', icon: 'acc-overview', aliases: ['/accounting'] },
      { path: '/accounting/periods', labelSv: 'Perioder', labelEn: 'Periods', icon: 'acc-periods' },
      { path: '/accounting/journal', labelSv: 'Journal', labelEn: 'Journal', icon: 'acc-journal' },
      { path: '/accounting/purchases', labelSv: 'Inköp', labelEn: 'Purchases', icon: 'acc-purchases' },
      { path: '/accounting/suppliers', labelSv: 'Leverantörer', labelEn: 'Suppliers', icon: 'acc-suppliers' },
      { path: '/accounting/sales', labelSv: 'Försäljning', labelEn: 'Sales', icon: 'acc-sales' },
      { path: '/accounting/receivables', labelSv: 'Kundfordringar', labelEn: 'Receivables', icon: 'acc-receivables' },
      { path: '/accounting/payments', labelSv: 'Betalningar & Matchning', labelEn: 'Payments & Matching', icon: 'acc-payments' },
      { path: '/accounting/vat-periods', labelSv: 'Momsperioder', labelEn: 'VAT periods', icon: 'acc-vat' },
      { path: '/accounting/integrity', labelSv: 'Integritet', labelEn: 'Integrity', icon: 'acc-integrity' },
    ],
  },
  {
    id: 'admin',
    labelSv: 'Administration',
    labelEn: 'Administration',
    items: [
      { path: '/portal/staff', labelSv: 'Personalkonton', labelEn: 'Staff users', icon: 'staff', adminOnly: true },
      { path: '/portal/settings/business', labelSv: 'Företagsuppgifter', labelEn: 'Business settings', icon: 'business', adminOnly: true },
      { path: '/portal/settings/margins', labelSv: 'Marginalregler', labelEn: 'Margin rules', icon: 'margins' },
      { path: '/portal/customers/questionnaire', labelSv: 'Hemprofilfrågor', labelEn: 'Home profile questions', icon: 'questionnaire' },
      { path: '/portal/settings/energy-tariffs', labelSv: 'Ellevio-tariffer', labelEn: 'Ellevio tariffs', icon: 'tariffs' },
      { path: '/portal/erd', labelSv: 'Databasdiagram', labelEn: 'Database ERD', icon: 'erd' },
    ],
  },
];

export type AppRole = 'staff' | 'customer';

/** Sidebar groups for a role in the global app shell. */
export function getNavGroupsForRole(role: AppRole): AppNavGroup[] {
  return role === 'staff' ? staffNavGroups : getCustomerNavGroups();
}

/** True when `pathname` should highlight `item` in the navigation. */
export function isNavItemActive(item: AppNavItem, pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (item.aliases?.some((alias) => normalized === alias)) return true;
  if (normalized === item.path) return true;
  if (item.end) return false;
  return normalized.startsWith(`${item.path}/`);
}

/** True when both the route and query string identify a sidebar sub-item. */
export function isNavSubItemActive(
  item: AppNavSubItem,
  pathname: string,
  search: string,
): boolean {
  const target = new URL(item.path, 'https://navigation.local');
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const targetPath = target.pathname.replace(/\/+$/, '') || '/';
  if (normalized !== targetPath) return false;

  const activeParams = new URLSearchParams(search);
  const targetTab = target.searchParams.get('tab');
  const activeTab = activeParams.get('tab');
  return activeTab === targetTab || (item.default === true && activeTab === null);
}

export interface ActiveNavMatch {
  group: AppNavGroup;
  item: AppNavItem;
}

/**
 * Finds the nav item matching `pathname`, preferring the most specific
 * (longest) path so nested routes resolve to the right entry.
 */
export function findActiveNavMatch(groups: AppNavGroup[], pathname: string): ActiveNavMatch | null {
  let best: ActiveNavMatch | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (!isNavItemActive(item, pathname)) continue;
      if (!best || item.path.length > best.item.path.length) {
        best = { group, item };
      }
    }
  }
  return best;
}

/** True when `pathname` belongs to the staff customer-view area
 *  (/portal/customers/:customerId/...), as opposed to a global staff page. */
export function isCustomerViewPath(pathname: string, customerId: string): boolean {
  return pathname.startsWith(`${getCustomerViewBasePath(customerId)}/`);
}
