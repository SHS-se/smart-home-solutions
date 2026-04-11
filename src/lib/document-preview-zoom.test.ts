/// <reference lib="deno.ns" />

import { computeFitScale, effectiveScaleFor } from './document-preview-zoom.ts';

// --- computeFitScale ---

Deno.test('computeFitScale returns null when container width is zero', () => {
  const result = computeFitScale({ w: 0, h: 600 }, { w: 595, h: 842 });
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

Deno.test('computeFitScale returns null when container height is zero', () => {
  const result = computeFitScale({ w: 800, h: 0 }, { w: 595, h: 842 });
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

Deno.test('computeFitScale returns null when content has zero dimensions', () => {
  const result = computeFitScale({ w: 800, h: 600 }, { w: 0, h: 0 });
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

Deno.test('computeFitScale fits A4 portrait into landscape container (height-constrained)', () => {
  // A4 at 72dpi: 595 x 842
  const result = computeFitScale({ w: 800, h: 600 }, { w: 595, h: 842 });
  if (result === null) throw new Error('Expected a number, got null');
  // verticalScale = (600 - 32) / 842 ≈ 0.6746
  // horizontalScale = (800 - 32) / 595 ≈ 1.2908
  // fitScale = min(0.6746, 1.2908) = 0.6746 (height-constrained)
  const expected = (600 - 32) / 842;
  if (Math.abs(result - expected) > 0.001) {
    throw new Error(`Expected ~${expected.toFixed(4)}, got ${result.toFixed(4)}`);
  }
});

Deno.test('computeFitScale fits wide content into narrow container (width-constrained)', () => {
  const result = computeFitScale({ w: 600, h: 800 }, { w: 1200, h: 400 });
  if (result === null) throw new Error('Expected a number, got null');
  // horizontalScale = (600 - 32) / 1200 ≈ 0.4733
  // verticalScale = (800 - 32) / 400 = 1.92
  // fitScale = min(0.4733, 1.92) = 0.4733 (width-constrained)
  const expected = (600 - 32) / 1200;
  if (Math.abs(result - expected) > 0.001) {
    throw new Error(`Expected ~${expected.toFixed(4)}, got ${result.toFixed(4)}`);
  }
});

Deno.test('computeFitScale clamps to minimum 0.1 for very small containers', () => {
  // Container much smaller than content
  const result = computeFitScale({ w: 40, h: 40 }, { w: 10000, h: 10000 });
  if (result === null) throw new Error('Expected a number, got null');
  // Both scales would be (40 - 32) / 10000 = 0.0008, clamped to 0.1
  if (result !== 0.1) throw new Error(`Expected 0.1, got ${result}`);
});

Deno.test('computeFitScale uses custom padding allowance', () => {
  const result = computeFitScale({ w: 100, h: 100 }, { w: 100, h: 100 }, 0);
  if (result === null) throw new Error('Expected a number, got null');
  // No padding: (100 - 0) / 100 = 1.0
  if (result !== 1.0) throw new Error(`Expected 1.0, got ${result}`);
});

Deno.test('computeFitScale produces exact fit when content matches container minus padding', () => {
  // Container 832x874, content 800x842, padding 32 → exact fit at scale 1.0
  const result = computeFitScale({ w: 832, h: 874 }, { w: 800, h: 842 });
  if (result === null) throw new Error('Expected a number, got null');
  // horizontal = (832 - 32) / 800 = 1.0, vertical = (874 - 32) / 842 = 1.0
  if (result !== 1.0) throw new Error(`Expected 1.0, got ${result}`);
});

// --- effectiveScaleFor ---

Deno.test('effectiveScaleFor returns fitScale when auto and fitScale available', () => {
  const result = effectiveScaleFor(true, 0.674, 1.0);
  if (result !== 0.674) throw new Error(`Expected 0.674, got ${result}`);
});

Deno.test('effectiveScaleFor falls back to manual scale when auto but fitScale is null', () => {
  const result = effectiveScaleFor(true, null, 1.5);
  if (result !== 1.5) throw new Error(`Expected 1.5, got ${result}`);
});

Deno.test('effectiveScaleFor returns manual scale when auto is off', () => {
  const result = effectiveScaleFor(false, 0.674, 1.5);
  if (result !== 1.5) throw new Error(`Expected 1.5, got ${result}`);
});

Deno.test('effectiveScaleFor returns manual scale when auto is off even if fitScale is null', () => {
  const result = effectiveScaleFor(false, null, 2.0);
  if (result !== 2.0) throw new Error(`Expected 2.0, got ${result}`);
});
