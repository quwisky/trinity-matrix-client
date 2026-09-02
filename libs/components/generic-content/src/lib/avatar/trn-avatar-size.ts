import type { TrnSize } from '@trinity/components/foundations';

export type TrnAvatarSize = Extract<
  TrnSize,
  '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
>;

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
  size: TrnAvatarSize,
  exact: number | null,
): number {
  if (exact !== null) {
    return boundedExactSize(exact);
  }

  return avatarSizePx[size];
}
