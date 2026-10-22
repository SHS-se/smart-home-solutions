interface PdfTextDocument {
  numPages: number;
  getPage(page: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str: string } | object> }>;
  }>;
}

export interface EmbeddedPdfText {
  text: string;
  isScanned: boolean;
  pageCount: number;
}

/** Keep browser and deployment extraction identical, including PDF item order. */
export async function extractEmbeddedPdfText(
  getDocument: (source: { data: Uint8Array }) => { promise: Promise<PdfTextDocument>; destroy(): Promise<void> },
  bytes: Uint8Array,
): Promise<EmbeddedPdfText> {
  const task = getDocument({ data: bytes });
  try {
    const pdf = await task.promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      for (const item of content.items) {
        if ('str' in item) text += item.str + ' ';
      }
      text += '\n';
    }
    return { text: text.trim(), isScanned: text.trim().length < 50, pageCount: pdf.numPages };
  } finally {
    await task.destroy();
  }
}
