export interface VatDeclarationRawAmounts {
  box05: number;
  box10: number;
  box11: number;
  box12: number;
  box20: number;
  box21: number;
  box22: number;
  box30: number;
  box31: number;
  box32: number;
  box48: number;
}

export interface VatDeclarationRoundedAmounts extends Record<keyof VatDeclarationRawAmounts, number> {
  momsBetala: number;
}

export interface VatDeclarationXmlBox {
  xmlTag: string;
  amount: number;
}

export function roundVatDeclarationAmount(amount: number): number {
  return Math.round(amount);
}

export function finalizeVatDeclarationAmounts(raw: VatDeclarationRawAmounts): VatDeclarationRoundedAmounts {
  const rounded = {
    box05: roundVatDeclarationAmount(raw.box05),
    box10: roundVatDeclarationAmount(raw.box10),
    box11: roundVatDeclarationAmount(raw.box11),
    box12: roundVatDeclarationAmount(raw.box12),
    box20: roundVatDeclarationAmount(raw.box20),
    box21: roundVatDeclarationAmount(raw.box21),
    box22: roundVatDeclarationAmount(raw.box22),
    box30: roundVatDeclarationAmount(raw.box30),
    box31: roundVatDeclarationAmount(raw.box31),
    box32: roundVatDeclarationAmount(raw.box32),
    box48: roundVatDeclarationAmount(raw.box48),
  };

  return {
    ...rounded,
    momsBetala: (rounded.box10 + rounded.box11 + rounded.box12 + rounded.box30 + rounded.box31 + rounded.box32) - rounded.box48,
  };
}

export function buildSkatteverketXml(
  orgNr: string,
  periodYYYYMM: string,
  declarationBoxes: VatDeclarationXmlBox[],
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="ISO-8859-1"?>',
    '<!DOCTYPE eSKDUpload PUBLIC "-//Skatteverket, Sweden//DTD Skatteverket eSKDUpload-DTD Version 6.0//SV" "https://www1.skatteverket.se/demoeskd/eSKDUpload_6p0.dtd">',
    '<eSKDUpload Version="6.0">',
    `<OrgNr>${orgNr}</OrgNr>`,
    '<Moms>',
    `<Period>${periodYYYYMM}</Period>`,
  ];

  for (const box of declarationBoxes) {
    if (box.xmlTag === 'MomsBetala' || box.amount !== 0) {
      lines.push(`<${box.xmlTag}>${box.amount}</${box.xmlTag}>`);
    }
  }

  lines.push('</Moms>');
  lines.push('</eSKDUpload>');
  return lines.join('\n');
}
