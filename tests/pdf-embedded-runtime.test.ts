import { assertEquals } from '@std/assert';
import { extractEmbeddedPdfText } from '../src/lib/pdf-embedded-text.ts';

Deno.test('shared PDF extraction preserves page and text-item order and destroys resources', async () => {
  let destroyed = 0;
  const result = await extractEmbeddedPdfText(() => ({ promise: Promise.resolve({ numPages: 2,
    getPage: async page => ({ getTextContent: async () => ({ items: [{ str: `page${page}` }, {}, { str: 'invoice billing text long enough for embedded-text detection' }] }) }),
    destroy: async () => { destroyed++; },
  }) }), new Uint8Array());
  assertEquals(result.text, 'page1 invoice billing text long enough for embedded-text detection \npage2 invoice billing text long enough for embedded-text detection');
  assertEquals(result.pageCount, 2); assertEquals(result.isScanned, false); assertEquals(destroyed, 1);
});
Deno.test('deployment Node runtime extracts a real synthetic embedded PDF', async () => {
  const script = `
    import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
    import { extractEmbeddedPdfText } from './src/lib/pdf-embedded-text.ts';
    const text = 'Synthetic energy invoice embedded text with enough content for parser extraction';
    const content = 'BT /F1 12 Tf 50 750 Td (' + text + ') Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + content.length + ' >>\\nstream\\n' + content + '\\nendstream'];
    let pdf = '%PDF-1.4\\n'; const offsets = [0];
    objects.forEach((object, i) => { offsets.push(pdf.length); pdf += (i+1) + ' 0 obj\\n' + object + '\\nendobj\\n'; });
    const xref = pdf.length;
    pdf += 'xref\\n0 6\\n0000000000 65535 f \\n' + offsets.slice(1).map(offset => String(offset).padStart(10,'0') + ' 00000 n \\n').join('');
    pdf += 'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF';
    const result = await extractEmbeddedPdfText(getDocument, new TextEncoder().encode(pdf));
    if (result.text !== text || result.isScanned || result.pageCount !== 1) throw new Error('Synthetic PDF extraction mismatch');
  `;
  const result = await new Deno.Command('node', { args: ['--experimental-strip-types', '--input-type=module', '-e', script], stdout: 'piped', stderr: 'piped' }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
});
