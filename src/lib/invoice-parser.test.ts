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

const AMAZON_RAW_TEXT = `Faktura  Sida 1 av 1  LU-BIO-04 Amazon EU S.à r.l. - 38 avenue John F. Kennedy, L-1855 Luxemburg, registrerat i Luxemburg (Registre de Commerce et des Sociétés (RCS)): B 101818 Amazon EU S.à r.l., Sverige Filial • Malmskillnadsgatan 36, 111 57 Stockholm, Sverige • momsnummer SE516412220101 • Registrerat i Bolagsverkets filialregister • Organisationsnummer: 516412-2201  Moms   Delsumma för artikel (exkl. moms) Delsumma moms 25 %   378,06 kr   94,52 kr Totalt   378,06 kr   94,52 kr  Totalsumma för faktura   472,58 kr Fakturauppgifter  Beställningsdatum   12 mars 2026 Ordernr   407-0705765-2582749  Betald  Referens-ID för betalning 3BOYvD8yTxgv7Yyv37yu Såld av Amazon EU S.à r.l., Sverige Filial Moms # SE516412220101 Fakturadatum/Leveransdatum   13 mars 2026 Fakturanr   SE6EK5YAEUI Summa att betala   472,58 kr  PHILIP CHEONG PORFYRVÄGEN 10, SE790519759101 TÄBY, 18734 SE  För kundsupport, gå till www.amazon.se/contact-us  Faktureringsadress  Philip Cheong Porfyrvägen 10, SE790519759101 TÄBY, 18734 SE  Leveransadress  Philip Cheong Porfyrvägen 10, SE790519759101 TÄBY, 18734 SE  Såld av  Amazon EU S.à r.l., Sverige Filial Malmskillnadsgatan 36 111 57 Stockholm Sverige Moms # SE516412220101  Beställningsinformation  Beskrivning   Antal   Enhetspris (exkl. moms) Moms   Enhetspris (inkl. moms) Delsumma för artikel (inkl. moms) Shelly Dimmer 2, Interruttore Varialuce Senza Fili, Confezione de 2, Wi-Fi, Nessun Hub o Neutro richiesto, Domotica, Compatibile con Alexa e Google Home, App iOS Android ASIN: B09RMQZ5ZY 1   458,06 kr   25 %   572,58 kr   572,58 kr Fraktavgifter   0,00 kr   0,00 kr   0,00 kr Kampanjer   -80,00 kr   -100,00 kr   -100,00 kr`;

const AMAZON_MARKETPLACE_RAW_TEXT = `Faktura  Sida 1 av 1  Moms deklarerat av Amazon i leveranslandet  Moms   Delsumma för artikel (exkl. moms) Delsumma moms 25 %   2 319,20 kr   579,80 kr Totalt   2 319,20 kr   579,80 kr  Totalsumma för faktura   2 899,00 kr Fakturauppgifter  Beställningsdatum   29.01.2026 Ordernr   407-5695034-0067546  Betald  Referens-ID för betalning 2EeXGfSTDIRazDBkqpS8 Såld av Shenzhenshi LingKeYun Technology Co., Ltd. Fakturadatum/Leveransdatum   30.01.2026 Fakturanr   SE60000DWSE0PI Summa att betala   2 899,00 kr  PHILIP CHEONG PORFYRVÄGEN 10 TÄBY, 18734 SE  För kundsupport, gå till www.amazon.se/contact-us  Faktureringsadress  Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE  Leveransadress  Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE  Såld av  Shenzhenshi LingKeYun Technology Co., Ltd.  龙华 区 大浪街道 赖 屋山社区金城工 业 园第三 栋504  深圳市, 广 东, 518000  CN  Beställningsinformation  Beskrivning   Antal   Enhetspris (exkl. moms) Moms   Enhetspris (inkl. moms) Delsumma för artikel (inkl. moms) Beelink MINI-S13 minidator, 13:e generationens Intel Alder Lake-N150 processor (upp till 3,6 GHz) minidator, 16 GB RAM, 500GB SSD, affärsdator, dubbel HDMI/WiFi 6/BT 5.2/RJ45/WOL | B0DPC1LVRF ASIN: B0DPC1LVRF 1   2 319,20 kr   25 %   2 899,00 kr   2 899,00 kr Fraktavgifter   0,00 kr   0,00 kr   0,00 kr`;

const AMAZON_MARKETPLACE_WITH_AMAZON_VAT_RAW_TEXT = `Faktura  Sida 1 av 1  Betald  Referens-ID för betalning 3paQJ67JVH4winXgCGZ1 Såld av ShenZhenShiYiDuoJinDianZiShangWuYouXianGongSi Fakturadatum/Leveransdatum 03.02.2026 Fakturanr SE6IPMBAEUD Summa att betala 112,98 kr  Moms deklarerat av Amazon Amazon EU S.a.r.L. Moms # LU20260743  Faktureringsadress Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE Leveransadress Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE  Såld av ShenZhenShiYiDuoJinDianZiShangWuYouXianGongSi QianWanYiLu1Hao ADong201Shi ShenZhenShi, QianHaiShenGangHeZuoQu, GuangDongSheng, 518000 CN  Beställningsinformation  Beskrivning Antal Enhetspris (exkl. moms) Moms Enhetspris (inkl. moms) Delsumma för artikel (inkl. moms) Ewwtrey 260 stycken M3-nylon sexkantskruvar mutter kretsavståndshållare 1 90,38 kr 25 % 112,98 kr 112,98 kr Fraktavgifter 0,00 kr 0,00 kr 0,00 kr Totalsumma för faktura 112,98 kr Moms Delsumma för artikel (exkl. moms) Delsumma moms 25 % 90,38 kr 22,60 kr Totalt 90,38 kr 22,60 kr`;

const OPENAI_RAW_TEXT = `Page 1 of 1  Invoice  Invoice number   56FB0333  0001  Date of issue   March 26, 2026 Date due   March 26, 2026 OpenAI VAT   EU372041333  OpenAI OpCo, LLC  1455 3rd Street San Francisco, California 94158 United States ar@openai.com EU OSS VAT EU372041333  Bill to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden phio@philbert.io SE VAT SE790519759101  Ship to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden  $10.00 USD due March 26, 2026  Pay online  Description   Qty   Unit price   Tax   Amount  OpenAI API usage credit   1   $10.00   0%   $10.00  Subtotal   $10.00 Total   $10.00  Amount due   $10.00 USD   1    Tax to be paid on reverse charge basis   1`;

const OPENAI_RAW_TEXT_0002 = `Page 1 of 1  Invoice  Invoice number   56FB0333  0002  Date of issue   March 28, 2026 Date due   March 28, 2026 OpenAI VAT   EU372041333  OpenAI OpCo, LLC  1455 3rd Street San Francisco, California 94158 United States ar@openai.com EU OSS VAT EU372041333  Bill to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden phio@philbert.io SE VAT SE790519759101  Ship to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden  $5.05 USD due March 28, 2026  Pay online  Description   Qty   Unit price   Tax   Amount  OpenAI API usage credit   1   $5.05   0%   $5.05  Subtotal   $5.05 Total   $5.05  Amount due   $5.05 USD   1    Tax to be paid on reverse charge basis   1`;

const LOVABLE_RAW_TEXT = `Page 1 of 1  Invoice  Invoice number   NQLFVPGN 0005  Date of issue   January 28, 2026 Date due   January 28, 2026  Lovable Labs Incorporated  1111b South Governors Avenue Dover, Delaware 19904 United States support@lovable.dev  Bill to  Philip Cheong Porfyrvägen 10 SE 187 34 Täby Sweden phio@philbert.io  €15.00 due January 28, 2026  Pay online  Credit Top-Up - 50 Credits  Description   Qty   Unit price   Tax   Amount  Build Credit Top-up Pro   50   €0.30   25% incl. (on €12.00 €15.00  Subtotal   €15.00 Total excluding tax   €12.00 VAT - Sweden 25% incl. on €12.00 €3.00 Total   €15.00  Amount due   €15.00`;

const LOVABLE_RAW_TEXT_WITH_NUL = `Page 1 of 1  Invoice  Invoice number   NQLFVPGN \u0000 0006  Date of issue   January 29, 2026 Date due   January 29, 2026  Lovable Labs Incorporated  1111b South Governors Avenue Dover, Delaware 19904 United States support@lovable.dev  Bill to  Philip Cheong Porfyrvägen 10 SE \u0000 187 34 Täby Sweden phio@philbert.io  €15.00 due January 29, 2026  Pay online  Credit Top-Up - 50 Credits  Description   Qty   Unit price   Tax   Amount  Build Credit Top-up Pro   50   €0.30   25% incl. (on €12.00 \u0000  €15.00  Subtotal   €15.00 Total excluding tax   €12.00 VAT - Sweden   \u0000 25% incl. on €12.00 \u0000   €3.00 Total   €15.00  Amount due   €15.00`;
const ANTHROPIC_RAW_TEXT = `Invoice Invoice number DSUQQKNL-0001 Date of issue March 26, 2026 Date due March 26, 2026 Anthropic, PBC 548 Market Street PMB 90375 San Francisco, California 94104 United States support@anthropic.com Bill to Phil's Individual Org Porfyrvägen 10 SE-187 34 Täby Sweden phio@philbert.io $12.50 USD due March 26, 2026 Pay online While we prefer electronic payment methods, any checks must be sent to the address below, NOT to our San Francisco office. PAYMENT ADDRESS: Anthropic, PBC P.O. Box 104477 Pasadena, CA 91189-4477 Description Qty Unit price Tax Amount One-time credit purchase 1 $10.00 25% $10.00 Subtotal $10.00 Total excluding tax $10.00 VAT - Sweden (25% on $10.00) $2.50 Total $12.50 Amount due $12.50 USD Page 1 of 1`;
const ANTHROPIC_RAW_TEXT_WITHOUT_PAYMENT_ADDRESS = `Invoice
Invoice number DSUQQKNL-0001
Date of issue March 26, 2026
Date due March 26, 2026
Anthropic, PBC
548 Market Street
PMB 90375
San Francisco, California 94104
United States
support@anthropic.com
Bill to
Phil's Individual Org
Porfyrvägen 10
SE-187 34 Täby
Sweden
phio@philbert.io
$12.50 USD due March 26, 2026
Pay online
Description Qty Unit price Tax Amount
One-time credit purchase 1 $10.00 25% $10.00
Subtotal $10.00
Total excluding tax $10.00
VAT - Sweden (25% on $10.00) $2.50
Total $12.50
Amount due $12.50 USD
Page 1 of 1`;
const UNKNOWN_LAYOUT_RAW_TEXT = `Supplier invoice Example Parts AB Reference 7721 Document date 2026-04-10 Customer Smart Home Solutions Total amount 1 245,00 kr`;

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
  assertEqual(parsed.fingerprint.id, 'stripe_tax_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
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
  assertEqual(parsed.fingerprint.id, 'ubiquiti_receipt_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText extracts Amazon Sweden invoice fields from flattened PDF text', () => {
  const parsed = parseInvoiceText(AMAZON_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Amazon EU S.à r.l., Sverige Filial', 'supplierName');
  assertEqual(parsed.supplierCountry, 'SE', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, 'SE6EK5YAEUI', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-03-13', 'invoiceDate');
  assertEqual(parsed.dueDate, null, 'dueDate');
  assertEqual(parsed.currency, 'SEK', 'currency');
  assertEqual(parsed.grossAmount, 472.58, 'grossAmount');
  assertEqual(parsed.vatAmount, 94.52, 'vatAmount');
  assertEqual(parsed.netAmount, 378.06, 'netAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.vatNumber, 'SE516412220101', 'vatNumber');
  assertEqual(parsed.description, 'Shelly Dimmer 2 (Amazon inköp)', 'description');
  assertEqual(parsed.fingerprint.id, 'amazon_sweden_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText extracts Amazon marketplace invoice VAT summary with spaced thousands separators', () => {
  const parsed = parseInvoiceText(AMAZON_MARKETPLACE_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Shenzhenshi LingKeYun Technology Co., Ltd.', 'supplierName');
  assertEqual(parsed.supplierCountry, 'CN', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, 'SE60000DWSE0PI', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-01-30', 'invoiceDate');
  assertEqual(parsed.dueDate, null, 'dueDate');
  assertEqual(parsed.currency, 'SEK', 'currency');
  assertEqual(parsed.grossAmount, 2899, 'grossAmount');
  assertEqual(parsed.vatAmount, 579.8, 'vatAmount');
  assertEqual(parsed.netAmount, 2319.2, 'netAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.vatNumber, null, 'vatNumber');
  assertEqual(parsed.description, 'Beelink MINI-S13 minidator (Amazon inköp)', 'description');
  assertEqual(parsed.fingerprint.id, 'amazon_marketplace_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText ignores Amazon marketplace VAT registration when the seller is a non-EU supplier', () => {
  const parsed = parseInvoiceText(AMAZON_MARKETPLACE_WITH_AMAZON_VAT_RAW_TEXT);

  assertEqual(parsed.supplierName, 'ShenZhenShiYiDuoJinDianZiShangWuYouXianGongSi', 'supplierName');
  assertEqual(parsed.supplierCountry, 'CN', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, 'SE6IPMBAEUD', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-02-03', 'invoiceDate');
  assertEqual(parsed.grossAmount, 112.98, 'grossAmount');
  assertEqual(parsed.netAmount, 90.38, 'netAmount');
  assertEqual(parsed.vatAmount, 22.6, 'vatAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.vatNumber, null, 'vatNumber');
  assertEqual(parsed.fingerprint.id, 'amazon_marketplace_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText keeps OpenAI invoice amounts in USD', () => {
  const parsed = parseInvoiceText(OPENAI_RAW_TEXT);

  assertEqual(parsed.supplierName, 'OpenAI OpCo, LLC', 'supplierName');
  assertEqual(parsed.supplierCountry, 'US', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, '56FB0333-0001', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-03-26', 'invoiceDate');
  assertEqual(parsed.currency, 'USD', 'currency');
  assertEqual(parsed.grossAmount, 10, 'grossAmount');
  assertEqual(parsed.vatAmount, 0, 'vatAmount');
  assertEqual(parsed.netAmount, 10, 'netAmount');
  assertEqual(parsed.vatRate, 0, 'vatRate');
  assertEqual(parsed.fingerprint.id, 'openai_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText preserves OpenAI invoice suffixes so consecutive invoices are distinct', () => {
  const parsed = parseInvoiceText(OPENAI_RAW_TEXT_0002);

  assertEqual(parsed.invoiceNumber, '56FB0333-0002', 'invoiceNumber');
  assertEqual(parsed.currency, 'USD', 'currency');
  assertEqual(parsed.grossAmount, 5.05, 'grossAmount');
  assertEqual(parsed.fingerprint.id, 'openai_invoice', 'fingerprint');
});

Deno.test('parseInvoiceText extracts Lovable invoice supplier, product description, and VAT-inclusive totals', () => {
  const parsed = parseInvoiceText(LOVABLE_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Lovable Labs Incorporated', 'supplierName');
  assertEqual(parsed.supplierCountry, 'US', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, 'NQLFVPGN-0005', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-01-28', 'invoiceDate');
  assertEqual(parsed.currency, 'EUR', 'currency');
  assertEqual(parsed.grossAmount, 15, 'grossAmount');
  assertEqual(parsed.netAmount, 12, 'netAmount');
  assertEqual(parsed.vatAmount, 3, 'vatAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.description, 'Build Credit Top-up Pro', 'description');
  assertEqual(parsed.fingerprint.id, 'lovable_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText ignores embedded NUL characters in Lovable PDF text extraction', () => {
  const parsed = parseInvoiceText(LOVABLE_RAW_TEXT_WITH_NUL);

  assertEqual(parsed.supplierName, 'Lovable Labs Incorporated', 'supplierName');
  assertEqual(parsed.invoiceNumber, 'NQLFVPGN-0006', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-01-29', 'invoiceDate');
  assertEqual(parsed.currency, 'EUR', 'currency');
  assertEqual(parsed.grossAmount, 15, 'grossAmount');
  assertEqual(parsed.netAmount, 12, 'netAmount');
  assertEqual(parsed.vatAmount, 3, 'vatAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.description, 'Build Credit Top-up Pro', 'description');
  assertEqual(parsed.fingerprint.id, 'lovable_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText extracts Anthropic invoice fields and recognizes the layout', () => {
  const parsed = parseInvoiceText(ANTHROPIC_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Anthropic, PBC', 'supplierName');
  assertEqual(parsed.supplierCountry, 'US', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, 'DSUQQKNL-0001', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-03-26', 'invoiceDate');
  assertEqual(parsed.currency, 'USD', 'currency');
  assertEqual(parsed.grossAmount, 12.5, 'grossAmount');
  assertEqual(parsed.netAmount, 10, 'netAmount');
  assertEqual(parsed.vatAmount, 2.5, 'vatAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.description, 'One-time credit purchase', 'description');
  assertEqual(parsed.fingerprint.id, 'anthropic_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText recognizes Anthropic invoices when the PDF extraction omits the payment address block', () => {
  const parsed = parseInvoiceText(ANTHROPIC_RAW_TEXT_WITHOUT_PAYMENT_ADDRESS);

  assertEqual(parsed.supplierName, 'Anthropic, PBC', 'supplierName');
  assertEqual(parsed.invoiceNumber, 'DSUQQKNL-0001', 'invoiceNumber');
  assertEqual(parsed.currency, 'USD', 'currency');
  assertEqual(parsed.grossAmount, 12.5, 'grossAmount');
  assertEqual(parsed.netAmount, 10, 'netAmount');
  assertEqual(parsed.vatAmount, 2.5, 'vatAmount');
  assertEqual(parsed.fingerprint.id, 'anthropic_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText flags unknown invoice layouts for parser review', () => {
  const parsed = parseInvoiceText(UNKNOWN_LAYOUT_RAW_TEXT);

  assertEqual(parsed.fingerprint.id, 'unknown_layout', 'fingerprint');
  assertEqual(parsed.fingerprint.recognized, false, 'fingerprint.recognized');
  assertEqual(parsed.parserReviewRequired, true, 'parserReviewRequired');
});
