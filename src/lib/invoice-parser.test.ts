import { describe, it, expect } from 'vitest';
import { parseInvoiceText } from './invoice-parser';

describe('parseInvoiceText', () => {
  it('extracts Stripe tax invoice fields from flattened PDF text', () => {
    const rawText = `Tax Invoice  Stripe Payments Europe, Limited One Wilton Park Wilton Place Dublin 2 D02FX04 Ireland Account Number   acct_1StAUdFat41qiV6Y Invoice Number   T41QIV6Y-2026-03-01 Invoice Date   Apr 5, 2026 Service Month   Mar 2026 Stripe VAT Number   IE 3206488LH Customer VAT Number   SE790519759101  Bill to Philip Cheong  Porfyrvägen 10 Täby 187 34 SE support@smarthomesolutions.se Reverse Charge VAT may be applicable.  Transfer Currency: SEK   Fee Amount   VAT  Invoicing  Fees for Invoicing  33.75 kr   0.00 kr Stripe Processing Fees  1 other payment totaling 8,437.50 kr  256.28 kr   0.00 kr  in SEK   in EUR  Stripe Fees   290.03 kr   €26.93 Total VAT   0.00 kr   €0.00  Total   290.03 kr   €26.93  Debited from your Balance –290.03 kr  Amount Due   0.00 kr Total VAT in EUR   €0.00 Total fees in EUR   €26.93 Exchange Rates (derived from average rate for period)  SEK / EUR   0.09286746291485691 EUR / SEK   10.768034019803293 Questions? We're here to help. Contact us at support.stripe.com.   Mar 2026 — Page 1 of 2 
The total above has been debited from your Stripe balance.  It is the responsibility of the customer to determine the correct local treatment in respect of the receipt of these services including any reverse charge considerations. Stripe Payments Europe, Limited is registered in Ireland, company number IE513174. Registered Office: One Wilton Park, Wilton Place, Dublin 2, D02FX04, Ireland. Mar 2026 — Page 2 of 2`;

    const parsed = parseInvoiceText(rawText);

    expect(parsed.supplierName).toBe('Stripe Payments Europe, Limited');
    expect(parsed.invoiceNumber).toBe('T41QIV6Y-2026-03-01');
    expect(parsed.invoiceDate).toBe('2026-04-05');
    expect(parsed.dueDate).toBeNull();
    expect(parsed.currency).toBe('SEK');
    expect(parsed.grossAmount).toBe(290.03);
    expect(parsed.vatAmount).toBe(0);
    expect(parsed.netAmount).toBe(290.03);
    expect(parsed.vatRate).toBe(0);
    expect(parsed.description).toBe('Stripe avgifter mars 2026');
  });
});
