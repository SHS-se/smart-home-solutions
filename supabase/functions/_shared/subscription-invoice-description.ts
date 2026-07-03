interface StripeInvoiceLineLike {
  description?: unknown;
  period?: {
    start?: unknown;
    end?: unknown;
  } | null;
}

interface StripeInvoiceLike {
  lines?: {
    data?: StripeInvoiceLineLike[];
  } | null;
}

function dateFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function subscriptionPeriodLabel(line: StripeInvoiceLineLike | undefined): string | null {
  const start = dateFromUnixSeconds(line?.period?.start);
  const end = dateFromUnixSeconds(line?.period?.end);
  return start && end ? `Giltighetsperiod: ${start} - ${end}` : null;
}

export function subscriptionInvoiceDescription(invoice: StripeInvoiceLike): string {
  const line = invoice.lines?.data?.[0];
  const rawDescription = typeof line?.description === "string" ? line.description.trim() : "";
  const description = rawDescription || "Månadsabonnemang Smart Home Solutions";
  const periodLabel = subscriptionPeriodLabel(line);

  if (!periodLabel || description.includes(periodLabel)) {
    return description;
  }

  return `${description} - ${periodLabel}`;
}
