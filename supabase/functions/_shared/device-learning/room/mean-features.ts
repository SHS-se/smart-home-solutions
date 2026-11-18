export interface MeanFeatureFactor { values: number[]; kind: number; segment: number; initialScale: number }

interface DurationClass {
  indices: number[];
  segments: Map<number, number[]>;
}

/** One reusable matrix for the full/training windows and every lag. The
 * factor keeps only the compressed rows, independent of this workspace. */
export class MeanFeatureWorkspace {
  private readonly data: Float64Array;
  private readonly shares: Float64Array;
  private readonly classes = new Map<number, DurationClass>();
  count = 0;

  constructor(capacity: number, private readonly width: number) {
    this.data = new Float64Array(capacity * width);
    this.shares = new Float64Array(capacity);
  }

  reset(): void {
    this.count = 0;
    this.classes.clear();
  }

  add(kind: number, segment: number, initialShare: number, values: readonly number[]): void {
    const index = this.count++;
    this.data.set(values, index * this.width);
    this.shares[index] = initialShare;
    let duration = this.classes.get(kind);
    if (!duration) {
      duration = { indices: [], segments: new Map() };
      this.classes.set(kind, duration);
    }
    duration.indices.push(index);
    if (initialShare === 0) return;
    let indices = duration.segments.get(segment);
    if (!indices) {
      indices = [];
      duration.segments.set(segment, indices);
    }
    indices.push(index);
  }

  /** Orthogonal row compression, including rank-deficient feature spans.
   * Givens rotations preserve the norm of every linear combination. */
  private compress(indices: readonly number[]): number[][] {
    const p = this.width, data = this.data;
    const scales = Array<number>(p).fill(0);
    for (const i of indices) {
      const base = i * p;
      for (let j = 0; j < p; j++) scales[j] = Math.hypot(scales[j], data[base + j]);
    }
    for (let j = 0; j < p; j++) scales[j] ||= 1;
    const upper = Array.from({ length: p }, () => Array<number>(p).fill(0));
    const row = Array<number>(p).fill(0);
    for (const i of indices) {
      const base = i * p;
      for (let j = 0; j < p; j++) row[j] = data[base + j] / scales[j];
      for (let j = 0; j < p; j++) {
        if (row[j] === 0) continue;
        const norm = Math.hypot(upper[j][j], row[j]);
        const cosine = upper[j][j] / norm, sine = row[j] / norm;
        for (let k = j; k < p; k++) {
          const previous = upper[j][k];
          upper[j][k] = cosine * previous + sine * row[k];
          row[k] = cosine * row[k] - sine * previous;
        }
      }
    }
    return upper.map(row => row.map((value, j) => value * scales[j]));
  }

  /** Preserve one scalar channel per (initial state, duration class). The
   * solver ties all channels for a segment to one nonnegative state. */
  factor(): MeanFeatureFactor[] {
    const result: MeanFeatureFactor[] = [], p = this.width, data = this.data, shares = this.shares;
    for (const [kind, { indices, segments }] of this.classes) {
      for (const [segment, members] of segments) {
        let norm = 0;
        for (const i of members) norm = Math.hypot(norm, shares[i]);
        for (const i of members) shares[i] /= norm;
        const values = Array<number>(p).fill(0);
        for (let pass = 0; pass < 2; pass++) for (let j = 0; j < p; j++) {
          let dot = 0;
          for (const i of members) dot += data[i * p + j] * shares[i];
          values[j] += dot;
          for (const i of members) data[i * p + j] -= dot * shares[i];
        }
        result.push({ values, kind, segment, initialScale: norm });
      }
      for (const values of this.compress(indices)) result.push({ values, kind, segment: -1, initialScale: 0 });
    }
    return result;
  }
}
