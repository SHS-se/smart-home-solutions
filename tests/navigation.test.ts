import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findActiveNavMatch,
  getCustomerNavItems,
  getCustomerViewBasePath,
  getNavGroupsForRole,
  isCustomerViewPath,
  isNavItemActive,
  publicNavItems,
  staffNavGroups,
} from "@/lib/navigation.ts";

const CUSTOMER_ID = "42900197-d688-4743-9165-c389aa6103a6";

// ─── Public nav ────────────────────────────────────────────────────────────────

Deno.test("public nav stays lightweight (3 marketing items)", () => {
  assertEquals(publicNavItems.length, 3);
  assertEquals(publicNavItems.map((i) => i.path), ["/services", "/knowledge", "/about"]);
});

// ─── Customer nav ──────────────────────────────────────────────────────────────

Deno.test("customer nav covers the customer portal pages", () => {
  const paths = getCustomerNavItems().map((i) => i.path);
  assertEquals(paths, [
    "/portal",
    "/portal/home-profile",
    "/portal/energy-history",
    "/portal/energy-modeling",
    "/portal/offers",
    "/portal/billing",
    "/portal/tickets",
    "/portal/account",
  ]);
});

Deno.test("customer nav contains no staff-only routes", () => {
  const paths = getCustomerNavItems().map((i) => i.path);
  for (const path of paths) {
    assertFalse(path.startsWith("/accounting"), `${path} is staff-only`);
    assertFalse(path.includes("/customers"), `${path} is staff-only`);
    assertFalse(path.includes("/skus"), `${path} is staff-only`);
    assertFalse(path.includes("/quotes"), `${path} is staff-only`);
    assertFalse(path.includes("/invoices"), `${path} is staff-only`);
  }
});

// ─── Staff customer-view nav ───────────────────────────────────────────────────

Deno.test("customer-view nav mirrors the customer nav, scoped to the customer", () => {
  const base = getCustomerViewBasePath(CUSTOMER_ID);
  assertEquals(base, `/portal/customers/${CUSTOMER_ID}`);

  const viewPaths = getCustomerNavItems(base).map((i) => i.path);
  assertEquals(viewPaths, [
    `${base}/overview`,
    `${base}/home-profile`,
    `${base}/energy-history`,
    `${base}/energy-modeling`,
    `${base}/offers`,
    `${base}/billing`,
    `${base}/tickets`,
    `${base}/account`,
  ]);

  // Same sections, same order, same labels as the real customer portal.
  const customerItems = getCustomerNavItems();
  const viewItems = getCustomerNavItems(base);
  assertEquals(viewItems.map((i) => i.labelSv), customerItems.map((i) => i.labelSv));
  assertEquals(viewItems.map((i) => i.icon), customerItems.map((i) => i.icon));
});

Deno.test("customer-view path detection distinguishes scoped from global pages", () => {
  assert(isCustomerViewPath(`/portal/customers/${CUSTOMER_ID}/billing`, CUSTOMER_ID));
  assert(isCustomerViewPath(`/portal/customers/${CUSTOMER_ID}/tickets/T-123`, CUSTOMER_ID));
  assertFalse(isCustomerViewPath("/portal/invoices", CUSTOMER_ID));
  assertFalse(isCustomerViewPath("/portal/customers", CUSTOMER_ID));
});

// ─── Staff nav ─────────────────────────────────────────────────────────────────

Deno.test("staff nav includes accounting as an integrated group", () => {
  const accounting = staffNavGroups.find((g) => g.id === "accounting");
  assert(accounting, "accounting group missing");
  assert(accounting!.collapsible, "accounting group should be collapsible");
  const paths = accounting!.items.map((i) => i.path);
  for (const expected of [
    "/accounting/overview",
    "/accounting/periods",
    "/accounting/journal",
    "/accounting/purchases",
    "/accounting/suppliers",
    "/accounting/sales",
    "/accounting/receivables",
    "/accounting/payments",
    "/accounting/vat-periods",
    "/accounting/integrity",
  ]) {
    assert(paths.includes(expected), `missing ${expected}`);
  }
});

Deno.test("staff nav covers CRM, sales, catalog and admin sections", () => {
  const ids = staffNavGroups.map((g) => g.id);
  assertEquals(ids, ["staff-home", "crm", "sales", "catalog", "accounting", "admin"]);

  const allPaths = staffNavGroups.flatMap((g) => g.items.map((i) => i.path));
  for (const expected of [
    "/portal",
    "/portal/customers",
    "/portal/contacts",
    "/portal/tickets",
    "/portal/quotes",
    "/portal/invoices",
    "/portal/boms",
    "/portal/skus",
    "/portal/templates",
    "/portal/device-catalog",
    "/portal/settings/margins",
    "/portal/customers/questionnaire",
    "/portal/erd",
  ]) {
    assert(allPaths.includes(expected), `missing ${expected}`);
  }
});

Deno.test("role selector returns the right groups", () => {
  assertEquals(getNavGroupsForRole("staff"), staffNavGroups);
  const customerGroups = getNavGroupsForRole("customer");
  assertEquals(customerGroups.length, 1);
  assertEquals(customerGroups[0].items.length, 8);
});

// ─── Active-state matching ─────────────────────────────────────────────────────

Deno.test("exact-match items only highlight on their own path", () => {
  const overview = getCustomerNavItems()[0];
  assert(isNavItemActive(overview, "/portal"));
  assertFalse(isNavItemActive(overview, "/portal/billing"));

  const customers = staffNavGroups
    .flatMap((g) => g.items)
    .find((i) => i.path === "/portal/customers")!;
  assert(isNavItemActive(customers, "/portal/customers"));
  // Customer-view and questionnaire pages must NOT highlight global "Kunder".
  assertFalse(isNavItemActive(customers, `/portal/customers/${CUSTOMER_ID}/overview`));
  assertFalse(isNavItemActive(customers, "/portal/customers/questionnaire"));
});

Deno.test("prefix items highlight on nested routes", () => {
  const skus = staffNavGroups.flatMap((g) => g.items).find((i) => i.path === "/portal/skus")!;
  assert(isNavItemActive(skus, "/portal/skus"));
  assert(isNavItemActive(skus, "/portal/skus/import"));
  assert(isNavItemActive(skus, "/portal/skus/categories"));

  const purchases = staffNavGroups
    .flatMap((g) => g.items)
    .find((i) => i.path === "/accounting/purchases")!;
  assert(isNavItemActive(purchases, "/accounting/purchases/upload"));
});

Deno.test("accounting overview alias matches /accounting", () => {
  const accOverview = staffNavGroups
    .flatMap((g) => g.items)
    .find((i) => i.path === "/accounting/overview")!;
  assert(isNavItemActive(accOverview, "/accounting"));
  assert(isNavItemActive(accOverview, "/accounting/overview"));
  assertFalse(isNavItemActive(accOverview, "/accounting/journal"));
});

Deno.test("findActiveNavMatch picks the most specific item", () => {
  const match = findActiveNavMatch(staffNavGroups, "/portal/customers/questionnaire");
  assert(match);
  assertEquals(match!.item.path, "/portal/customers/questionnaire");
  assertEquals(match!.group.id, "admin");

  const ticketsMatch = findActiveNavMatch(staffNavGroups, "/portal/tickets/T-001");
  assert(ticketsMatch);
  assertEquals(ticketsMatch!.item.path, "/portal/tickets");

  assertEquals(findActiveNavMatch(staffNavGroups, "/no/such/path"), null);
});
