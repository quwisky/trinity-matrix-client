import type { TrnSize } from '@trinity/components/foundations';

export type TrnAvatarSize = Extract<
  TrnSize,
  '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
>;

export type TrnAvatarSizeInput = TrnAvatarSize | number;

const avatarSizePx = {
  '2xs': 16,
  xs: 20,
  sm: 24,
  md: 28,
  lg: 32,
  xl: 40,
  '2xl': 48,
} as const satisfies Record<TrnAvatarSize, number>;

const MIN_AVATAR_SIZE_PX = 16;
const MAX_AVATAR_SIZE_PX = 256;

function boundedExactSize(size: number): number {
  if (!Number.isFinite(size)) {
    return avatarSizePx.xl;
  }

  return Math.min(
    MAX_AVATAR_SIZE_PX,
    Math.max(MIN_AVATAR_SIZE_PX, Math.round(size)),
  );
}

/** Resolves the ordinal recipe, with a bounded escape for geometry-sensitive layouts. */
export function resolveTrnAvatarSize(
  size: TrnAvatarSizeInput,
  exact: number | null,
): number {
  if (exact !== null) {
    return boundedExactSize(exact);
  }

  if (typeof size === 'number') {
    // Numeric size predates the recipe scale and historically passed its exact value to
    // width/height. Preserve every finite value during the expansion window; only the new,
    // explicitly constrained exactSize escape is rounded and bounded.
    return Number.isFinite(size) ? size : avatarSizePx.xl;
  }

  return avatarSizePx[size];
}
