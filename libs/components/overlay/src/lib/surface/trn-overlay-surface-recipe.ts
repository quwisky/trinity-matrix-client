import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnOverlaySurfaceVariant = Extract<
  TrnVariant,
  'neutral' | 'accent'
>;
export type TrnOverlaySurfaceSize = Extract<
  TrnSize,
  'sm' | 'md' | 'lg' | 'xl' | '2xl'
>;
export type TrnOverlaySurfaceLayout =
  'dialog' | 'sheet' | 'popover' | 'panel' | 'workspace' | 'fullscreen';

const variantRecipe = {
  neutral:
    'border-[var(--trinity-border-subtle)] bg-[var(--trinity-surface-raised)] text-[var(--trinity-text-bright)]',
  accent:
    'border-[var(--trinity-state-attention-surface)] bg-[var(--trinity-state-attention-surface)] text-[var(--trinity-state-attention-foreground)]',
} as const;

const sizeRecipe = {
  sm: '[--trn-overlay-inline-size:20rem]',
  md: '[--trn-overlay-inline-size:26rem]',
  lg: '[--trn-overlay-inline-size:32rem]',
  xl: '[--trn-overlay-inline-size:40rem]',
  '2xl': '[--trn-overlay-inline-size:72rem]',
} as const;

const layoutRecipe = {
  dialog:
    'max-h-[calc(100dvh-1.5rem)] w-[min(92vw,var(--trn-overlay-inline-size))] max-w-full rounded-[var(--trinity-shape-overlay-radius)]',
  sheet:
    'max-h-[80svh] w-screen max-w-[100vw] rounded-t-[var(--trinity-shape-overlay-radius)] rounded-b-none border-x-0 border-b-0',
  popover:
    'max-h-[calc(100dvh-1rem)] min-w-full w-max max-w-[min(92vw,var(--trn-overlay-inline-size))] rounded-[var(--trinity-shape-overlay-radius)]',
  panel:
    'h-dvh w-screen rounded-none border-y-0 border-e-0 md:w-[var(--trn-overlay-inline-size)]',
  workspace:
    'flex h-[min(48rem,calc(100dvh-2*var(--trinity-space-4)))] w-[min(var(--trn-overlay-inline-size),calc(100vw-2*var(--trinity-space-4)))] max-w-full rounded-[var(--trinity-shape-overlay-radius)]',
  fullscreen: 'h-full w-full rounded-none border-0 shadow-none',
} as const;

/**
 * One owned surface recipe for document content and CDK portal content.
 *
 * Semantic treatment, ordinal size, and structural layout stay independent. Positioning,
 * focus, dismissal, and lifecycle belong to the overlay behavior that presents the surface.
 */
export function trnOverlaySurfaceRecipe(
  variant: TrnOverlaySurfaceVariant,
  size: TrnOverlaySurfaceSize,
  layout: TrnOverlaySurfaceLayout,
): string {
  return hlm(
    'block overflow-hidden border border-solid shadow-overlay',
    variantRecipe[variant],
    sizeRecipe[size],
    layoutRecipe[layout],
  );
}
