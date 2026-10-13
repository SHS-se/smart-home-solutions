export const sek = (amount: number | null | undefined) => amount == null ? '—' : `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SEK`;
