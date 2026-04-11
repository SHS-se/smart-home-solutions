export interface Size {
  w: number;
  h: number;
}

const DEFAULT_PADDING = 32;

/**
 * Compute the scale factor that fits content inside a container with padding.
 * Returns null if any dimension is zero (auto-fit cannot be computed yet).
 */
export function computeFitScale(
  containerSize: Size,
  contentSize: Size,
  paddingAllowance = DEFAULT_PADDING
): number | null {
  if (!contentSize.w || !contentSize.h || !containerSize.w || !containerSize.h) {
    return null;
  }

  const horizontalScale = Math.max((containerSize.w - paddingAllowance) / contentSize.w, 0.1);
  const verticalScale = Math.max((containerSize.h - paddingAllowance) / contentSize.h, 0.1);
  return Math.min(horizontalScale, verticalScale);
}

/**
 * Determine the effective display scale given auto-scale state.
 * When auto-scale is on, uses fitScale if available, otherwise falls back to manual scale.
 */
export function effectiveScaleFor(
  autoScale: boolean,
  fitScale: number | null,
  manualScale: number
): number {
  return autoScale ? fitScale ?? manualScale : manualScale;
}
