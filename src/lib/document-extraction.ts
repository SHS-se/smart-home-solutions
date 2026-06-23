/**
 * Local document text extraction pipeline.
 * PDF: pdfjs-dist for embedded text.
 * Images & scanned PDFs: Tesseract.js WASM OCR.
 * All processing happens in the browser — documents never leave the system.
 */

import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export interface WordPosition {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractionResult {
  rawText: string;
  words: WordPosition[];
  isScanned: boolean;
  pageCount: number;
}

async function extractPdfText(file: File): Promise<{ text: string; isScanned: boolean; pageCount: number }> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if ('str' in item) text += item.str + ' ';
    }
    text += '\n';
  }
  return { text: text.trim(), isScanned: text.trim().length < 50, pageCount: pdf.numPages };
}

async function renderPdfPageToBlob(file: File): Promise<Blob> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Render failed')), 'image/png'));
}

async function runOcr(input: File | Blob): Promise<ExtractionResult> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('swe+eng');
  const result = await worker.recognize(input);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = result.data as any;
  const words: WordPosition[] = (data.words || []).map((w) => ({
    text: w.text,
    x: w.bbox.x0,
    y: w.bbox.y0,
    width: w.bbox.x1 - w.bbox.x0,
    height: w.bbox.y1 - w.bbox.y0,
  }));
  await worker.terminate();
  return { rawText: data.text, words, isScanned: true, pageCount: 1 };
}

function isHeic(file: File): boolean {
  const n = file.name.toLowerCase();
  return n.endsWith('.heic') || n.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
}

export async function extractDocumentContent(
  file: File,
  onProgress?: (message: string, pct: number) => void,
): Promise<ExtractionResult> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  if (!isPdf) {
    let input: File | Blob = file;
    if (isHeic(file)) {
      onProgress?.('Konverterar HEIC...', 15);
      const heic2any = (await import('heic2any')).default;
      const result = await heic2any({ blob: file, toType: 'image/png', quality: 1 });
      input = Array.isArray(result) ? result[0] : result;
    }
    onProgress?.('Kör OCR på bild...', 30);
    try {
      const r = await runOcr(input);
      onProgress?.('Klar', 100);
      return r;
    } catch (err) {
      console.error('OCR failed:', err);
      onProgress?.('OCR misslyckades – fyll i manuellt', 0);
      return { rawText: '', words: [], isScanned: true, pageCount: 1 };
    }
  }

  onProgress?.('Läser PDF...', 20);
  const { text, isScanned, pageCount } = await extractPdfText(file);
  if (!isScanned) {
    onProgress?.('Text extraherad', 100);
    return { rawText: text, words: [], isScanned: false, pageCount };
  }

  onProgress?.('Skannad PDF – kör OCR...', 40);
  try {
    const blob = await renderPdfPageToBlob(file);
    onProgress?.('OCR pågår...', 60);
    const ocrResult = await runOcr(blob);
    onProgress?.('Klar', 100);
    return { ...ocrResult, pageCount };
  } catch (err) {
    console.error('OCR failed on scanned PDF:', err);
    onProgress?.('OCR misslyckades – fyll i manuellt', 0);
    return { rawText: '', words: [], isScanned: true, pageCount };
  }
}
