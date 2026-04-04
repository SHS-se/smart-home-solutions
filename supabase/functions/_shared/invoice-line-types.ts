export type InvoiceLineType = "hardware" | "labor" | "travel_other";

export function normalizeInvoiceLineType(value: string | null | undefined): InvoiceLineType {
  switch (value) {
    case "hardware":
      return "hardware";
    case "labor":
      return "labor";
    case "travel":
    case "other":
    case "travel_other":
      return "travel_other";
    default:
      throw new Error(`Unsupported invoice line type: ${value ?? "(missing)"}`);
  }
}
