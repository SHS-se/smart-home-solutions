/// <reference lib="deno.ns" />

import { parseInvoiceText } from './invoice-parser.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const STRIPE_RAW_TEXT = `Tax Invoice  Stripe Payments Europe, Limited One Wilton Park Wilton Place Dublin 2 D02FX04 Ireland Account Number   acct_1StAUdFat41qiV6Y Invoice Number   T41QIV6Y-2026-03-01 Invoice Date   Apr 5, 2026 Service Month   Mar 2026 Stripe VAT Number   IE 3206488LH Customer VAT Number   SE790519759101  Bill to Philip Cheong  Porfyrvägen 10 Täby 187 34 SE support@smarthomesolutions.se Reverse Charge VAT may be applicable.  Transfer Currency: SEK   Fee Amount   VAT  Invoicing  Fees for Invoicing  33.75 kr   0.00 kr Stripe Processing Fees  1 other payment totaling 8,437.50 kr  256.28 kr   0.00 kr  in SEK   in EUR  Stripe Fees   290.03 kr   €26.93 Total VAT   0.00 kr   €0.00  Total   290.03 kr   €26.93  Debited from your Balance –290.03 kr  Amount Due   0.00 kr Total VAT in EUR   €0.00 Total fees in EUR   €26.93 Exchange Rates (derived from average rate for period)  SEK / EUR   0.09286746291485691 EUR / SEK   10.768034019803293 Questions? We're here to help. Contact us at support.stripe.com.   Mar 2026 — Page 1 of 2 
The total above has been debited from your Stripe balance.  It is the responsibility of the customer to determine the correct local treatment in respect of the receipt of these services including any reverse charge considerations. Stripe Payments Europe, Limited is registered in Ireland, company number IE513174. Registered Office: One Wilton Park, Wilton Place, Dublin 2, D02FX04, Ireland. Mar 2026 — Page 2 of 2`;
const MNU_RAW_TEXT = `a m punkt nu Sverige AB  Älvsby Industriväg 29C, 139 52 Värmdö, Sverige Kontaktinformation: info@m.nu, 013-353403 (Vi föredrar kontakt via epost)  Organisationsnummer:   556871-8133  Momsreg.nr:   SE556871813301  Godkänd för F-skatt  Följesedel  Faktura-/Leveransadress  Philip Cheong Philip Cheong Porfyrvägen 10 18734 TÄBY Sweden  Faktureringsadress  Philip Cheong Philip Cheong Porfyrvägen 10 18734 TÄBY Sweden  Orderdatum:   2026-02-25  Fakturadatum:   2026-03-11  Fakturanr/Order-id:   20533959  Kundnummer:   73501  Betalning:   collectorcheckout  Hylla   Antal   Art.nr:   Namn / Färg   Typ:   Pris   Moms   Summa  DC5   4   TH-S02D   Aqara Aqara Temperatur, Luftfuktighet & Lufttryck - T1 / N/A   -   4st à 199.00 :-   25%   796.00 :- Fraktsätt   69.00 :- Netto   692.00 :- Moms (25%)   173.00 :-  Summa:   865.00 :-`;

const UBIQUITI_RAW_TEXT = `Ubiquiti Store Europe   Receipt / VAT Invoice  Ubiquiti International Holding B.V.  eu.store@ui.com  Invoice No.:   EU4860167  Invoice Date:   2026/03/10  Payment status:   Authorized  Billing Address  Smart Home Solutions  SE790519759101  Philip Cheong  Porfyrvägen 10  Täby, Stockholms län, 187 34, SE  +46 70 287 08 14  Shipping Address  Smart Home Solutions  SE790519759101  Philip Cheong  Porfyrvägen 10  Täby, 187 34, SE  +46 70 287 08 14  NO.   PRODUCT DESCRIPTION   HS CODE   QTY   PRICE   VAT TOTAL   TOTAL  1   Dream Router 7 (EU Version)  UDR7-EU   851762   1   250,00   €   0,00   €   250,00   €  Total Amount   250,00   €  Shipping Amount   6,80   €  Total   256,80   €  Ubiquiti International Holding B.V. Ekkersrijt 3102, Son, 5692 CC, NL, VAT ID: NL859253582B01. CoC: 72831995 VAT exempt intra-Community supply under Article 138 of the EU VAT Directive`;
const BBQKEES_RAW_TEXT = `BBQKees Electronics B.V. Meuleneind 5 5528 CJ Hoogeloon Netherlands shop@bbqkees-electronics.nl KvK: 97682829 VAT: NL868180038B01 +31624253658 INVOICE Smart Home Solutions Philip Cheong Porfyrvägen 10 187 34 Täby Sweden VAT #: SE 790519759101 phil@smarthomesolutions.se Invoice Number: 2026031600 Invoice Date: 26/03/2026 Order Number: 24859 Order Date: 26/03/2026 Payment Method: Card Product HS Code Quantity Total VAT Price Gateway E32 V2 KIT (Ethernet + WiFi Edition V2 KIT) VAT EXEMPT SKU: E32-v2-KIT-1 Weight: 0.35 kg 84718000 1 €100,00 €0,00 €100,00 Subtotal €100,00 Shipping €10,22 Payment Fee €1,50 Total €111,72 This is a VAT exempt intra community supply General terms and conditions apply: bbqkees.com/terms-and-conditions`;

const AMAZON_RAW_TEXT = `Faktura  Sida 1 av 1  LU-BIO-04 Amazon EU S.à r.l. - 38 avenue John F. Kennedy, L-1855 Luxemburg, registrerat i Luxemburg (Registre de Commerce et des Sociétés (RCS)): B 101818 Amazon EU S.à r.l., Sverige Filial • Malmskillnadsgatan 36, 111 57 Stockholm, Sverige • momsnummer SE516412220101 • Registrerat i Bolagsverkets filialregister • Organisationsnummer: 516412-2201  Moms   Delsumma för artikel (exkl. moms) Delsumma moms 25 %   378,06 kr   94,52 kr Totalt   378,06 kr   94,52 kr  Totalsumma för faktura   472,58 kr Fakturauppgifter  Beställningsdatum   12 mars 2026 Ordernr   407-0705765-2582749  Betald  Referens-ID för betalning 3BOYvD8yTxgv7Yyv37yu Såld av Amazon EU S.à r.l., Sverige Filial Moms # SE516412220101 Fakturadatum/Leveransdatum   13 mars 2026 Fakturanr   SE6EK5YAEUI Summa att betala   472,58 kr  PHILIP CHEONG PORFYRVÄGEN 10, SE790519759101 TÄBY, 18734 SE  För kundsupport, gå till www.amazon.se/contact-us  Faktureringsadress  Philip Cheong Porfyrvägen 10, SE790519759101 TÄBY, 18734 SE  Leveransadress  Philip Cheong Porfyrvägen 10, SE790519759101 TÄBY, 18734 SE  Såld av  Amazon EU S.à r.l., Sverige Filial Malmskillnadsgatan 36 111 57 Stockholm Sverige Moms # SE516412220101  Beställningsinformation  Beskrivning   Antal   Enhetspris (exkl. moms) Moms   Enhetspris (inkl. moms) Delsumma för artikel (inkl. moms) Shelly Dimmer 2, Interruttore Varialuce Senza Fili, Confezione de 2, Wi-Fi, Nessun Hub o Neutro richiesto, Domotica, Compatibile con Alexa e Google Home, App iOS Android ASIN: B09RMQZ5ZY 1   458,06 kr   25 %   572,58 kr   572,58 kr Fraktavgifter   0,00 kr   0,00 kr   0,00 kr Kampanjer   -80,00 kr   -100,00 kr   -100,00 kr`;

const AMAZON_MARKETPLACE_RAW_TEXT = `Faktura  Sida 1 av 1  Moms deklarerat av Amazon i leveranslandet  Moms   Delsumma för artikel (exkl. moms) Delsumma moms 25 %   2 319,20 kr   579,80 kr Totalt   2 319,20 kr   579,80 kr  Totalsumma för faktura   2 899,00 kr Fakturauppgifter  Beställningsdatum   29.01.2026 Ordernr   407-5695034-0067546  Betald  Referens-ID för betalning 2EeXGfSTDIRazDBkqpS8 Såld av Shenzhenshi LingKeYun Technology Co., Ltd. Fakturadatum/Leveransdatum   30.01.2026 Fakturanr   SE60000DWSE0PI Summa att betala   2 899,00 kr  PHILIP CHEONG PORFYRVÄGEN 10 TÄBY, 18734 SE  För kundsupport, gå till www.amazon.se/contact-us  Faktureringsadress  Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE  Leveransadress  Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE  Såld av  Shenzhenshi LingKeYun Technology Co., Ltd.  龙华 区 大浪街道 赖 屋山社区金城工 业 园第三 栋504  深圳市, 广 东, 518000  CN  Beställningsinformation  Beskrivning   Antal   Enhetspris (exkl. moms) Moms   Enhetspris (inkl. moms) Delsumma för artikel (inkl. moms) Beelink MINI-S13 minidator, 13:e generationens Intel Alder Lake-N150 processor (upp till 3,6 GHz) minidator, 16 GB RAM, 500GB SSD, affärsdator, dubbel HDMI/WiFi 6/BT 5.2/RJ45/WOL | B0DPC1LVRF ASIN: B0DPC1LVRF 1   2 319,20 kr   25 %   2 899,00 kr   2 899,00 kr Fraktavgifter   0,00 kr   0,00 kr   0,00 kr`;

const AMAZON_MARKETPLACE_WITH_AMAZON_VAT_RAW_TEXT = `Faktura  Sida 1 av 1  Betald  Referens-ID för betalning 3paQJ67JVH4winXgCGZ1 Såld av ShenZhenShiYiDuoJinDianZiShangWuYouXianGongSi Fakturadatum/Leveransdatum 03.02.2026 Fakturanr SE6IPMBAEUD Summa att betala 112,98 kr  Moms deklarerat av Amazon Amazon EU S.a.r.L. Moms # LU20260743  Faktureringsadress Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE Leveransadress Philip Cheong Porfyrvägen 10 TÄBY, 18734 SE  Såld av ShenZhenShiYiDuoJinDianZiShangWuYouXianGongSi QianWanYiLu1Hao ADong201Shi ShenZhenShi, QianHaiShenGangHeZuoQu, GuangDongSheng, 518000 CN  Beställningsinformation  Beskrivning Antal Enhetspris (exkl. moms) Moms Enhetspris (inkl. moms) Delsumma för artikel (inkl. moms) Ewwtrey 260 stycken M3-nylon sexkantskruvar mutter kretsavståndshållare 1 90,38 kr 25 % 112,98 kr 112,98 kr Fraktavgifter 0,00 kr 0,00 kr 0,00 kr Totalsumma för faktura 112,98 kr Moms Delsumma för artikel (exkl. moms) Delsumma moms 25 % 90,38 kr 22,60 kr Totalt 90,38 kr 22,60 kr`;

const OPENAI_RAW_TEXT = `Page 1 of 1  Invoice  Invoice number   56FB0333  0001  Date of issue   March 26, 2026 Date due   March 26, 2026 OpenAI VAT   EU372041333  OpenAI OpCo, LLC  1455 3rd Street San Francisco, California 94158 United States ar@openai.com EU OSS VAT EU372041333  Bill to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden phio@philbert.io SE VAT SE790519759101  Ship to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden  $10.00 USD due March 26, 2026  Pay online  Description   Qty   Unit price   Tax   Amount  OpenAI API usage credit   1   $10.00   0%   $10.00  Subtotal   $10.00 Total   $10.00  Amount due   $10.00 USD   1    Tax to be paid on reverse charge basis   1`;

const OPENAI_RAW_TEXT_0002 = `Page 1 of 1  Invoice  Invoice number   56FB0333  0002  Date of issue   March 28, 2026 Date due   March 28, 2026 OpenAI VAT   EU372041333  OpenAI OpCo, LLC  1455 3rd Street San Francisco, California 94158 United States ar@openai.com EU OSS VAT EU372041333  Bill to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden phio@philbert.io SE VAT SE790519759101  Ship to  Phil Smith Porfyrvägen 10 SE  187 34 Täby Sweden  $5.05 USD due March 28, 2026  Pay online  Description   Qty   Unit price   Tax   Amount  OpenAI API usage credit   1   $5.05   0%   $5.05  Subtotal   $5.05 Total   $5.05  Amount due   $5.05 USD   1    Tax to be paid on reverse charge basis   1`;

const LOVABLE_RAW_TEXT = `Page 1 of 1  Invoice  Invoice number   NQLFVPGN 0005  Date of issue   January 28, 2026 Date due   January 28, 2026  Lovable Labs Incorporated  1111b South Governors Avenue Dover, Delaware 19904 United States support@lovable.dev  Bill to  Philip Cheong Porfyrvägen 10 SE 187 34 Täby Sweden phio@philbert.io  €15.00 due January 28, 2026  Pay online  Credit Top-Up - 50 Credits  Description   Qty   Unit price   Tax   Amount  Build Credit Top-up Pro   50   €0.30   25% incl. (on €12.00 €15.00  Subtotal   €15.00 Total excluding tax   €12.00 VAT - Sweden 25% incl. on €12.00 €3.00 Total   €15.00  Amount due   €15.00`;

const LOVABLE_RAW_TEXT_WITH_NUL = `Page 1 of 1  Invoice  Invoice number   NQLFVPGN \u0000 0006  Date of issue   January 29, 2026 Date due   January 29, 2026  Lovable Labs Incorporated  1111b South Governors Avenue Dover, Delaware 19904 United States support@lovable.dev  Bill to  Philip Cheong Porfyrvägen 10 SE \u0000 187 34 Täby Sweden phio@philbert.io  €15.00 due January 29, 2026  Pay online  Credit Top-Up - 50 Credits  Description   Qty   Unit price   Tax   Amount  Build Credit Top-up Pro   50   €0.30   25% incl. (on €12.00 \u0000  €15.00  Subtotal   €15.00 Total excluding tax   €12.00 VAT - Sweden   \u0000 25% incl. on €12.00 \u0000   €3.00 Total   €15.00  Amount due   €15.00`;
const LOVABLE_SUBSCRIPTION_RAW_TEXT = `Invoice Invoice number NQLFVPGN-0001 Date of issue January 12, 2026 Date due January 12, 2026 Lovable Labs Incorporated 1111b South Governors Avenue Dover, Delaware 19904 United States support@lovable.dev Bill to Philip Cheong Porfyrvägen 10 SE-187 34 Täby Sweden phio@philbert.io €25.00 due January 12, 2026 Pay online Description Qty Unit price Tax Amount Pro 1 Jan 12 – Feb 12, 2026 1 €25.00 25% incl. (on €20.00) €25.00 Subtotal €25.00 Total excluding tax €20.00 VAT - Sweden (25% incl. on €20.00) €5.00 Total €25.00 Amount due €25.00 Page 1 of 1`;
const LOVABLE_REVERSE_CHARGE_RAW_TEXT = `Invoice Invoice number NQLFVPGN-0017 Date of issue February 12, 2026 Date due February 12, 2026 Lovable 1111b South Governors Avenue Dover, Delaware 19904 United States support@lovable.dev EU OSS VAT EU372090612 GB VAT GB509006909 Bill to Philip Cheong Porfyrvägen 10 SE-187 34 Täby Sweden +46 70 287 08 14 phio@philbert.io SE VAT SE790519759101 €25.00 due February 12, 2026 Pay online Description Qty Unit price Tax Amount Pro 1 Feb 12–Mar 12, 2026 1 €25.00 0% €25.00 Subtotal €25.00 Total €25.00 Amount due €25.00 Tax to be paid on reverse charge basis Page 1 of 1`;
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

const NEW_LAYOUT_CASES = [
  {
    name: 'Elbutik invoice 10885174',
    rawText: `Elbutik Scandinavia AB Faktura Faktura nr Datum Kund nr Ordernr Sida 10885174 23.04.2026 2022056 2742889 1 Betalningsvillkor: Nätbutiken Klarna Checkout 07.05.2026 Summa 896,00 Moms % 224,00 Att betala 1 120,00 Adress: Org.nr: Telefon: E-post: Elbutik Scandinavia AB 556688-8409 +46(0)46 460 10 90 info@elbutik.se Product no. Description Quantity Price Disc. % Amount 1820180 Schneider Electric Exxact Vipptryckknapp trapp/1-pol Vit 5 87,20 436,00 SEK`,
    expected: {
      supplierName: 'Elbutik Scandinavia AB', supplierCountry: 'SE', invoiceNumber: '10885174',
      invoiceDate: '2026-04-23', dueDate: '2026-05-07', grossAmount: 1120, netAmount: 896,
      vatAmount: 224, currency: 'SEK', description: 'Schneider Electric Exxact Vipptryckknapp trapp/1-pol Vit',
      orgNumber: '556688-8409', vatNumber: null, fingerprintId: 'elbutik_scandinavia_invoice',
      documentType: 'receipt',
    },
  },
  {
    name: 'Elbutik invoice 10887500',
    rawText: `Elbutik Scandinavia AB Faktura Faktura nr Datum Kund nr Ordernr Sida 10887500 30.04.2026 2022056 2742889 1 Betalningsvillkor: Nätbutiken Klarna Checkout 14.05.2026 Summa 47,20 Moms % 11,80 Att betala 59,00 Adress: Org.nr: Telefon: E-post: Elbutik Scandinavia AB 556688-8409 +46(0)46 460 10 90 info@elbutik.se Product no. Description Quantity Price Disc. % Amount 1893164 Shelly Wall Switch Adapter - Gira/Merten/Exxact 1 47,20 47,20 SEK`,
    expected: {
      supplierName: 'Elbutik Scandinavia AB', supplierCountry: 'SE', invoiceNumber: '10887500',
      invoiceDate: '2026-04-30', dueDate: '2026-05-14', grossAmount: 59, netAmount: 47.2,
      vatAmount: 11.8, currency: 'SEK', description: 'Shelly Wall Switch Adapter - Gira/Merten/Exxact',
      orgNumber: '556688-8409', vatNumber: null, fingerprintId: 'elbutik_scandinavia_invoice',
      documentType: 'receipt',
    },
  },
  {
    name: 'CS Megastore receipt 500375961',
    rawText: `Kvitto 500375961 CS MEGASTORE AB - www.csmegastore.se Kvitto Kundnummer: 1019412881 Kvittonr.: 500375961 Fakturadatum 13-05-2026 leveransmetod: Bring - Nordic - Business Parcel Bulk Betalingsdatum: 27-05-2026 Valuta SEK Betalningsmetod: Quickpay/Billwerk CS MEGASTORE AB * Slottsgatan 20 * SE-211 33 Malmö * salg@csmegastore.se * www.csmegastore.se Vat-no: SE5595229401 Artikelnr. Benämning Antal Pris / St. Moms % Pris (ex. moms) 21380963 Shelly PM Mini Gen3 3800235261613 4 98,40 25,00 393,60 Totalt ex. moms 393,60 Moms 98,40 Total inkl. moms SEK 492,00 Ordern är betald!`,
    expected: {
      supplierName: 'CS MEGASTORE AB', supplierCountry: 'SE', invoiceNumber: '500375961',
      invoiceDate: '2026-05-13', dueDate: '2026-05-27', grossAmount: 492, netAmount: 393.6,
      vatAmount: 98.4, currency: 'SEK', description: 'Shelly PM Mini Gen3', orgNumber: null,
      vatNumber: 'SE5595229401', fingerprintId: 'cs_megastore_receipt', documentType: 'receipt',
    },
  },
  {
    name: 'CS Megastore receipt 500384956',
    rawText: `Kvitto 500384956 CS MEGASTORE AB - www.csmegastore.se Kvitto Kundnummer: 1019412881 Kvittonr.: 500384956 Fakturadatum 21-05-2026 Valuta SEK Betalningsmetod: Quickpay/Billwerk CS MEGASTORE AB * Slottsgatan 20 * SE-211 33 Malmö * salg@csmegastore.se * www.csmegastore.se Vat-no: SE5595229401 Artikelnr. Benämning Antal Pris / St. Moms % Pris (ex. moms) 21380963 Shelly PM Mini Gen3 3800235261613 4 98,39 25,00 393,56 Totalt ex. moms 432,76 Moms 108,19 Total inkl. moms SEK 540,95 Ordern är betald!`,
    expected: {
      supplierName: 'CS MEGASTORE AB', supplierCountry: 'SE', invoiceNumber: '500384956',
      invoiceDate: '2026-05-21', dueDate: null, grossAmount: 540.95, netAmount: 432.76,
      vatAmount: 108.19, currency: 'SEK', description: 'Shelly PM Mini Gen3', orgNumber: null,
      vatNumber: 'SE5595229401', fingerprintId: 'cs_megastore_receipt', documentType: 'receipt',
    },
  },
  ...[
    ['784794-1005', 'Jul 02, 2026', 'Bankgiro Number Fee', 39],
    ['784794-1002', 'Jun 02, 2026', 'Bankgiro Number Fee', 39],
    ['784794-1003', 'Jun 09, 2026', 'Lunar Essential', 1190],
  ].map(([invoiceNumber, invoiceDate, product, amount]) => ({
    name: `Lunar invoice ${invoiceNumber}`,
    rawText: `INVOICE #${invoiceNumber} Billed to Invoice details Lunar Bank A/S Hack Kampmanns Plads 10 Invoice No: ${invoiceNumber} DK-8000 Aarhus C Invoice Date: ${invoiceDate} CVR: 39697696 Invoice Due: ${invoiceDate} lunar.app support@lunar.app Product Details Price ${product} 1x ${product} ${amount} kr Subtotal: ${amount} kr VAT: 0 kr Total: ${amount} kr Page 1 of 1`,
    expected: {
      supplierName: 'Lunar Bank A/S', supplierCountry: 'DK', invoiceNumber,
      invoiceDate: invoiceDate === 'Jul 02, 2026' ? '2026-07-02' : invoiceDate === 'Jun 02, 2026' ? '2026-06-02' : '2026-06-09',
      dueDate: invoiceDate === 'Jul 02, 2026' ? '2026-07-02' : invoiceDate === 'Jun 02, 2026' ? '2026-06-02' : '2026-06-09',
      grossAmount: amount, netAmount: amount, vatAmount: 0, currency: 'SEK', description: product,
      orgNumber: '39697696', vatNumber: null, fingerprintId: 'lunar_bank_invoice', documentType: null,
    },
  })),
  {
    name: 'Z.ai receipt with non-breaking identifier hyphens',
    rawText: `Receipt Receipt number RCPT‑6280974‑202604‑0001 Invoice number INV‑6280974‑202604‑0001 Date paid May 8, 2026 zai 10 ANSON ROAD, #26‑03 INTERNATIONAL PLAZA, SINGAPORE SINGAPORE 079903 Singapore user_feedback@z.ai Bill to Smart Home Solutions Marked as paid on May 8, 2026 Description Qty Unit price Amount API usage (glm‑5) 1 $3.7993124 $3.7993124 Subtotal $3.7993124 Total $3.7993124 Amount paid $3.7993124 USD`,
    expected: {
      supplierName: 'zai', supplierCountry: 'SG', invoiceNumber: 'INV-6280974-202604-0001',
      invoiceDate: '2026-05-08', dueDate: null, grossAmount: 3.8, netAmount: 3.8,
      vatAmount: 0, currency: 'USD', description: 'API usage (glm-5)', orgNumber: null,
      vatNumber: null, fingerprintId: 'zai_receipt', documentType: 'receipt',
    },
  },
] as const;

for (const testCase of NEW_LAYOUT_CASES) {
  Deno.test(`parseInvoiceText imports ${testCase.name}`, () => {
    const parsed = parseInvoiceText(testCase.rawText);
    const expected = testCase.expected;

    assertEqual(parsed.supplierName, expected.supplierName, 'supplierName');
    assertEqual(parsed.supplierCountry, expected.supplierCountry, 'supplierCountry');
    assertEqual(parsed.invoiceNumber, expected.invoiceNumber, 'invoiceNumber');
    assertEqual(parsed.invoiceDate, expected.invoiceDate, 'invoiceDate');
    assertEqual(parsed.dueDate, expected.dueDate, 'dueDate');
    assertEqual(parsed.grossAmount, expected.grossAmount, 'grossAmount');
    assertEqual(parsed.netAmount, expected.netAmount, 'netAmount');
    assertEqual(parsed.vatAmount, expected.vatAmount, 'vatAmount');
    assertEqual(parsed.currency, expected.currency, 'currency');
    assertEqual(parsed.description, expected.description, 'description');
    assertEqual(parsed.orgNumber, expected.orgNumber, 'orgNumber');
    assertEqual(parsed.vatNumber, expected.vatNumber, 'vatNumber');
    assertEqual(parsed.fingerprint.id, expected.fingerprintId, 'fingerprint');
    assertEqual(parsed.documentType, expected.documentType, 'documentType');
    assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
  });
}

Deno.test('parseInvoiceText extracts Stripe tax invoice fields from flattened PDF text', () => {
  const parsed = parseInvoiceText(STRIPE_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Stripe Payments Europe, Limited', 'supplierName');
  assertEqual(parsed.supplierCountry, 'IE', 'supplierCountry');
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

Deno.test('parseInvoiceText extracts M.nu invoice fields from flattened PDF text', () => {
  const parsed = parseInvoiceText(MNU_RAW_TEXT);

  assertEqual(parsed.supplierName, 'a m punkt nu Sverige AB', 'supplierName');
  assertEqual(parsed.supplierCountry, 'SE', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, '20533959', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-03-11', 'invoiceDate');
  assertEqual(parsed.currency, 'SEK', 'currency');
  assertEqual(parsed.grossAmount, 865, 'grossAmount');
  assertEqual(parsed.netAmount, 692, 'netAmount');
  assertEqual(parsed.vatAmount, 173, 'vatAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.vatNumber, 'SE556871813301', 'vatNumber');
  assertEqual(parsed.description, 'Aqara Aqara Temperatur', 'description');
  assertEqual(parsed.fingerprint.id, 'mnu_invoice', 'fingerprint');
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

Deno.test('parseInvoiceText extracts BBQKees invoice fields from flattened PDF text', () => {
  const parsed = parseInvoiceText(BBQKEES_RAW_TEXT);

  assertEqual(parsed.supplierName, 'BBQKees Electronics B.V.', 'supplierName');
  assertEqual(parsed.supplierCountry, 'NL', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, '2026031600', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-03-26', 'invoiceDate');
  assertEqual(parsed.currency, 'EUR', 'currency');
  assertEqual(parsed.grossAmount, 111.72, 'grossAmount');
  assertEqual(parsed.netAmount, 100, 'netAmount');
  assertEqual(parsed.vatAmount, 0, 'vatAmount');
  assertEqual(parsed.vatRate, 0, 'vatRate');
  assertEqual(parsed.vatNumber, 'NL868180038B01', 'vatNumber');
  assertEqual(parsed.description, 'Gateway E32 V2 KIT (Ethernet + WiFi Edition V2 KIT)', 'description');
  assertEqual(parsed.fingerprint.id, 'bbqkees_invoice', 'fingerprint');
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

Deno.test('parseInvoiceText recognizes Lovable monthly subscription invoices', () => {
  const parsed = parseInvoiceText(LOVABLE_SUBSCRIPTION_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Lovable Labs Incorporated', 'supplierName');
  assertEqual(parsed.supplierCountry, 'US', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, 'NQLFVPGN-0001', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-01-12', 'invoiceDate');
  assertEqual(parsed.currency, 'EUR', 'currency');
  assertEqual(parsed.grossAmount, 25, 'grossAmount');
  assertEqual(parsed.netAmount, 20, 'netAmount');
  assertEqual(parsed.vatAmount, 5, 'vatAmount');
  assertEqual(parsed.vatRate, 25, 'vatRate');
  assertEqual(parsed.description, 'Pro 1 Jan 12 – Feb 12', 'description');
  assertEqual(parsed.fingerprint.id, 'lovable_invoice', 'fingerprint');
  assertEqual(parsed.parserReviewRequired, false, 'parserReviewRequired');
});

Deno.test('parseInvoiceText recognizes Lovable reverse-charge subscription invoices', () => {
  const parsed = parseInvoiceText(LOVABLE_REVERSE_CHARGE_RAW_TEXT);

  assertEqual(parsed.supplierName, 'Lovable Labs Incorporated', 'supplierName');
  assertEqual(parsed.supplierCountry, 'US', 'supplierCountry');
  assertEqual(parsed.invoiceNumber, 'NQLFVPGN-0017', 'invoiceNumber');
  assertEqual(parsed.invoiceDate, '2026-02-12', 'invoiceDate');
  assertEqual(parsed.currency, 'EUR', 'currency');
  assertEqual(parsed.grossAmount, 25, 'grossAmount');
  assertEqual(parsed.netAmount, 25, 'netAmount');
  assertEqual(parsed.vatAmount, 0, 'vatAmount');
  assertEqual(parsed.vatRate, 0, 'vatRate');
  assertEqual(parsed.vatNumber, 'EU372090612', 'vatNumber');
  assertEqual(parsed.description, 'Pro 1 Feb 12–Mar 12', 'description');
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
