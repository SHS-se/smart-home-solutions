/// <reference lib="deno.ns" />

import { parseInvoiceText } from './invoice-parser.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const STRIPE_RAW_TEXT = `Tax Invoice  Stripe Payments Europe, Limited One Wilton Park Wilton Place Dublin 2 D02FX04 Ireland Account Number   acct_1StAUdFat41qiV6Y Invoice Number   T41QIV6Y-2026-03-01 Invoice Date   Apr 5, 2026 Service Month   Mar 2026 Stripe VAT Number   IE 3206488LH Customer VAT Number   SE790519759101  Bill to Philip Cheong  Porfyrvägen 10 Täby 187 34 SE support@smarthomesolutions.se Reverse Charge VAT may be applicable.  Transfer Currency: SEK   Fee Amount   VAT  Invoicing  Fees for Invoicing  33.75 kr   0.00 kr Stripe Processing Fees  1 other payment totaling 8,437.50 kr  256.28 kr   0.00 kr  in SEK   in EUR  Stripe Fees   290.03 kr   €26.93 Total VAT   0.00 kr   €0.00  Total   290.03 kr   €26.93  Debited from your Balance –290.03 kr  Amount Due   0.00 kr Total VAT in EUR   €0.00 Total fees in EUR   €26.93 Exchange Rates (derived from average rate for period)  SEK / EUR   0.09286746291485691 EUR / SEK   10.768034019803293 Questions? We're here to help. Contact us at support.stripe.com.   Mar 2026 — Page 1 of 2 
The total above has been debited from your Stripe balance.  It is the responsibility of the customer to determine the correct local treatment in respect of the receipt of these services including any reverse charge considerations. Stripe Payments Europe, Limited is registered in Ireland, company number IE513174. Registered Office: One Wilton Park, Wilton Place, Dublin 2, D02FX04, Ireland. Mar 2026 — Page 2 of 2`;

const UBIQUITI_RAW_TEXT = `Ubiquiti Store Europe   Receipt / VAT Invoice  Ubiquiti International Holding B.V.  eu.store@ui.com  Invoice No.:   EU4860167  Invoice Date:   2026/03/10  Payment status:   Authorized  Billing Address  Smart Home Solutions  SE790519759101  Philip Cheong  Porfyrvägen 10  Täby, Stockholms län, 187 34, SE  +46 70 287 08 14  Shipping Address  Smart Home Solutions  SE790519759101  Philip Cheong  Porfyrvägen 10  Täby, 187 34, SE  +46 70 287 08 14  NO.   PRODUCT DESCRIPTION   HS CODE   QTY   PRICE   VAT TOTAL   TOTAL  1   Dream Router 7 (EU Version)  UDR7-EU   851762   1   250,00   €   0,00   €   250,00   €  Total Amount   250,00   €  Shipping Amount   6,80   €  Total   256,80   €  Ubiquiti International Holding B.V. Ekkersrijt 3102, Son, 5692 CC, NL, VAT ID: NL859253582B01. CoC: 72831995 VAT exempt intra-Community supply under Article 138 of the EU VAT Directive`;

Deno.test('parseInvoiceText extracts Stripe tax invoice fields from flattened PDF text', () => {
  const parsed = parseInvoiceText(STRIPE_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Stripe Payments Europe, Limited', 'supplierName');
  assertEqual(parsed.invoiceNumber, 'T41QIV6Y-2026-03-01', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-04-05', 'invoiceDate');
  assertEqual(parsed.dueDate, null, 'dueDate');
  assertEqual(parsed.currency, 'SEK', 'currency');
  assertEqual(parsed.grossAmount, 290.03, 'grossAmount');
  assertEqual(parsed.vatAmount, 0, 'vatAmount');
  assertEqual(parsed.netAmount, 290.03, 'netAmount');
  assertEqual(parsed.vatRate, 0, 'vatRate');
  assertEqual(parsed.description, 'Stripe avgifter mars 2026', 'description');
});

Deno.test('parseInvoiceText extracts Ubiquiti receipt totals from flattened PDF text', () => {
  const parsed = parseInvoiceText(UBIQUITI_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Ubiquiti Store Europe', 'supplierName');
  assertEqual(parsed.invoiceNumber, 'EU4860167', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-03-10', 'invoiceDate');
  assertEqual(parsed.dueDate, null, 'dueDate');
  assertEqual(parsed.currency, 'EUR', 'currency');
  assertEqual(parsed.grossAmount, 256.8, 'grossAmount');
  assertEqual(parsed.vatAmount, 0, 'vatAmount');
  assertEqual(parsed.netAmount, 256.8, 'netAmount');
  assertEqual(parsed.vatRate, 0, 'vatRate');
});
