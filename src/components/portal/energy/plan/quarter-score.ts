// How a quarter's points are written and coloured, wherever the plan chart shows them.

// The palette runs −2…+2; anything beyond takes the darkest shade.
export const scoreColour = (score: number) => `var(--plan-score-${score < 0 ? 'n' : 'p'}${Math.min(2, Math.abs(score))})`;
export const signedPoints = (value: number, digits = 0) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
