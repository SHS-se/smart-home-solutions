/** An index is meaningful only within the auction's owning pricing book. */
export type PairPriceIndex = number & { readonly __pairPrice: unique symbol };

/**
 * Exact numerical prices retained across transfer rescans within one worker
 * invocation. The owning auction freezes prices, durations, wear and limits.
 * Source/destination revisions and maximum power cover its mutable inputs.
 * Physical feasibility and the ordered winner comparison stay with the auction.
 */
export class PairPricingBook {
  private readonly sourceRevision: Uint32Array;
  private readonly loadRevision: Uint32Array;
  private readonly sourceUnits: Float64Array;
  private readonly sourceOccupied: Float64Array;
  private readonly sourceReturned: Float64Array;
  private readonly sourceSolar: Float64Array;
  private readonly loadSpent: Float64Array;
  private readonly loadImport: Float64Array;
  private readonly pricedSourceRevision: Uint32Array;
  private readonly pricedLoadRevision: Uint32Array;
  private readonly maximum: Float64Array;
  private readonly powers: Float64Array;
  private readonly scores: Float64Array;
  private readonly eligibility: Uint8Array;
  private readonly upperScore: Float64Array;

  constructor(private readonly count: number) {
    const pairs = count * count;
    this.sourceRevision = new Uint32Array(count).fill(1);
    this.loadRevision = new Uint32Array(count).fill(1);
    this.sourceUnits = new Float64Array(count).fill(NaN);
    this.sourceOccupied = new Float64Array(count).fill(NaN);
    this.sourceReturned = new Float64Array(count).fill(NaN);
    this.sourceSolar = new Float64Array(count).fill(NaN);
    this.loadSpent = new Float64Array(count).fill(NaN);
    this.loadImport = new Float64Array(count).fill(NaN);
    this.pricedSourceRevision = new Uint32Array(pairs);
    this.pricedLoadRevision = new Uint32Array(pairs);
    this.maximum = new Float64Array(pairs);
    this.powers = new Float64Array(pairs * 3);
    this.scores = new Float64Array(pairs * 3);
    this.eligibility = new Uint8Array(pairs);
    this.upperScore = new Float64Array(pairs).fill(-Infinity);
  }

  updateSource(index: number, units: number, occupied: number, returned: number, solar: number): void {
    if (Object.is(this.sourceUnits[index], units) &&
      Object.is(this.sourceOccupied[index], occupied) &&
      Object.is(this.sourceReturned[index], returned) &&
      Object.is(this.sourceSolar[index], solar)) return;
    this.sourceUnits[index] = units;
    this.sourceOccupied[index] = occupied;
    this.sourceReturned[index] = returned;
    this.sourceSolar[index] = solar;
    this.sourceRevision[index] += 1;
  }

  updateLoad(index: number, spent: number, imported: number): void {
    if (Object.is(this.loadSpent[index], spent) && Object.is(this.loadImport[index], imported)) return;
    this.loadSpent[index] = spent;
    this.loadImport[index] = imported;
    this.loadRevision[index] += 1;
  }

  lookup(charge: number, load: number, maximum: number): PairPriceIndex | undefined {
    const index = charge * this.count + load;
    return this.pricedSourceRevision[index] === this.sourceRevision[charge] &&
        this.pricedLoadRevision[index] === this.loadRevision[load] &&
        Object.is(this.maximum[index], maximum)
      ? index as PairPriceIndex
      : undefined;
  }

  prepare(charge: number, load: number, maximum: number): PairPriceIndex {
    const index = charge * this.count + load;
    this.pricedSourceRevision[index] = this.sourceRevision[charge];
    this.pricedLoadRevision[index] = this.loadRevision[load];
    this.maximum[index] = maximum;
    this.eligibility[index] = 0;
    this.upperScore[index] = -Infinity;
    return index as PairPriceIndex;
  }

  record(index: PairPriceIndex, level: number, power: number, score: number, eligible: boolean): void {
    this.powers[index * 3 + level] = power;
    this.scores[index * 3 + level] = score;
    if (eligible) {
      this.eligibility[index] |= 1 << level;
      // The legacy comparison does not reject NaN scores. They must therefore
      // keep the pair observable even when its other levels cannot win.
      this.upperScore[index] = Math.max(this.upperScore[index], score);
    }
  }

  /** A bound over already priced levels; it does not change their fold order. */
  canBeat(index: PairPriceIndex, threshold: number): boolean {
    if (!this.eligibility[index]) return false;
    // Negate the old rejection comparison, including its NaN behavior.
    return !(this.upperScore[index] <= threshold);
  }

  eligible(index: PairPriceIndex, level: number): boolean {
    return (this.eligibility[index] & (1 << level)) !== 0;
  }

  power(index: PairPriceIndex, level: number): number {
    return this.powers[index * 3 + level];
  }

  score(index: PairPriceIndex, level: number): number {
    return this.scores[index * 3 + level];
  }
}
