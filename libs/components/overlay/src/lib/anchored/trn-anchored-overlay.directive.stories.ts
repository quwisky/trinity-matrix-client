import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnOverlaySurfaceDirective } from '../surface/trn-overlay-surface.directive';
import { TrnAnchoredOverlayDirective } from './trn-anchored-overlay.directive';

/**
 * The geometry, which is the half the unit tests deliberately do not touch.
 *
 * jsdom does no layout, so where a layer actually lands is a browser's answer — these stories
 * are where you get it. Two behaviours are worth looking at and neither is visible in a still:
 *
 * - **It flips rather than going off-screen.** Shrink the viewport until the anchor is near
 *   the top and the layer moves below it instead of being pushed half out of view.
 * - **It follows the anchor.** Scroll the story; the layer tracks rather than staying where
 *   it was first drawn. Absolute positioning inside the anchor's own box gets that free but
 *   pays for it by being clipped; this is the other trade.
 *
 * `Clipped` is the story that makes the case for the whole thing: the same layer, positioned
 * the old way inside an `overflow: hidden` ancestor.
 */
const meta: Meta<TrnAnchoredOverlayDirective> = {
  title: 'Components/Anchored overlay',
  component: TrnAnchoredOverlayDirective,
  decorators: [
    (story) => ({
      ...story(),
      moduleMetadata: {
        imports: [TrnAnchoredOverlayDirective, TrnOverlaySurfaceDirective],
      },
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'A floating layer positioned against an element and rendered in the CDK overlay ' +
          'container, so it is not clipped by the anchor’s ancestors. Flips at the viewport ' +
          'edge, follows the anchor on scroll, closes on an outside press.',
      },
    },
  },
  argTypes: {
    side: { control: 'select', options: ['top', 'bottom', 'left', 'right'] },
    align: { control: 'select', options: ['start', 'center', 'end'] },
    matchAnchorWidth: { control: 'boolean' },
    closeOnOutsidePress: { control: 'boolean' },
    open: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<TrnAnchoredOverlayDirective>;

const layer = (label: string) => `
  <div
    trnOverlaySurface
    variant="neutral"
    size="sm"
    layout="popover"
    class="p-3 text-sm"
    data-testid="anchored-surface"
  >
    ${label}
  </div>`;

/** Above the anchor and right-aligned — where the composer's emoji picker sits. */
export const AboveTheAnchor: Story = {
  render: () => ({
    props: { open: true },
    template: `
      <div class="flex h-64 items-end">
        <div #anchor class="w-80 rounded-md border border-border p-2 text-sm">
          Message #general
        </div>
        <ng-template
          [trnAnchoredOverlay]="anchor"
          [(open)]="open"
          side="top"
          align="end"
        >
          ${layer('Emoji picker')}
        </ng-template>
      </div>`,
  }),
};

/**
 * As wide as the field it completes, so it reads as part of the input rather than as a
 * popover beside it. This is the suggestion-menu case.
 */
export const MatchingTheAnchorWidth: Story = {
  render: () => ({
    props: { open: true },
    template: `
      <div class="flex h-64 items-end">
        <div #anchor class="w-96 rounded-md border border-border p-2 text-sm">
          :smi
        </div>
        <ng-template
          [trnAnchoredOverlay]="anchor"
          [(open)]="open"
          side="top"
          align="start"
          [matchAnchorWidth]="true"
        >
          ${layer('😀 :smile: &nbsp; 😃 :smiley: &nbsp; 😏 :smirk:')}
        </ng-template>
      </div>`,
  }),
};

/** Every side/alignment pair is available through the story controls and URL args. */
export const PositionCatalog: Story = {
  args: {
    side: 'bottom',
    align: 'center',
    matchAnchorWidth: false,
    closeOnOutsidePress: true,
    open: true,
  },
  render: (args) => ({
    props: args,
    template: `
      <div class="grid h-80 place-items-center p-24">
        <button #anchor type="button" class="rounded-md border border-border p-3">
          Position anchor
        </button>
        <ng-template
          [trnAnchoredOverlay]="anchor"
          [(open)]="open"
          [side]="side"
          [align]="align"
          [matchAnchorWidth]="matchAnchorWidth"
          [closeOnOutsidePress]="closeOnOutsidePress"
        >
          ${layer('Positioned portal surface')}
        </ng-template>
      </div>`,
  }),
};

/** Both outside-press policies, including their model write-back, in one driven story. */
export const OutsidePressPolicyCatalog: Story = {
  render: () => ({
    props: {
      dismissibleOpen: true,
      persistentOpen: true,
    },
    template: `
      <div class="grid min-h-96 place-items-center gap-24 p-20">
        <button type="button" data-testid="outside-press-target">
          Outside both surfaces
        </button>
        <div class="flex gap-64">
          <div>
            <button #dismissibleAnchor type="button" class="rounded-md border border-border p-3">
              Dismissible anchor
            </button>
            <span data-testid="dismissible-model-state">
              {{ dismissibleOpen ? 'open' : 'closed' }}
            </span>
            <ng-template
              [trnAnchoredOverlay]="dismissibleAnchor"
              [(open)]="dismissibleOpen"
              [closeOnOutsidePress]="true"
              side="top"
              align="center"
            >
              ${layer('Closes on an outside press')}
            </ng-template>
          </div>
          <div>
            <button #persistentAnchor type="button" class="rounded-md border border-border p-3">
              Derived-state anchor
            </button>
            <span data-testid="persistent-model-state">
              {{ persistentOpen ? 'open' : 'closed' }}
            </span>
            <ng-template
              [trnAnchoredOverlay]="persistentAnchor"
              [(open)]="persistentOpen"
              [closeOnOutsidePress]="false"
              side="top"
              align="center"
            >
              ${layer('Stays open on an outside press')}
            </ng-template>
          </div>
        </div>
      </div>`,
  }),
};

/**
 * Anchored near the top, so the requested side has nowhere to go.
 *
 * `createMenuPosition` returns the position AND its mirror, which is what lets CDK put the
 * layer below instead of pushing it half off the viewport. Nothing in the markup asks for
 * that; it is the reason the helper is used rather than a hand-written position.
 */
export const FlipsAtTheViewportEdge: Story = {
  render: () => ({
    props: { open: true },
    template: `
      <div class="flex items-start">
        <div #anchor class="w-80 rounded-md border border-border p-2 text-sm">
          Anchored at the very top
        </div>
        <ng-template [trnAnchoredOverlay]="anchor" [(open)]="open" side="top" align="start">
          ${layer('Asked for above; drawn below, because above is off-screen.')}
        </ng-template>
      </div>`,
  }),
};

/**
 * The anchor changes shape and the layer stays with it — in width and in position.
 *
 * Type into the field: it grows a line, its top edge moves, and the layer moves with it. Drag
 * the handle at the corner to widen it and the layer widens too. Neither is free — CDK
 * recomputes a connected position on scroll and on nothing else, and reads `width` once — and
 * both matter for the first consumer, whose textarea auto-grows as you type and whose pane
 * can be dragged wider underneath an open layer.
 *
 * Before the `ResizeObserver` behind this, growing the field by one line left the layer 162px
 * from where it should have been, overlapping the very thing it was anchored to.
 */
export const FollowsAResizingAnchor: Story = {
  render: () => ({
    props: { open: true },
    template: `
      <div class="flex h-72 items-end">
        <textarea
          #anchor
          rows="1"
          class="w-96 resize rounded-md border border-border bg-transparent p-2 text-sm"
        >Type more, or drag the corner.</textarea>
        <ng-template
          [trnAnchoredOverlay]="anchor"
          [(open)]="open"
          side="top"
          align="start"
          [matchAnchorWidth]="true"
        >
          ${layer('Still exactly as wide as the field, and still just above it.')}
        </ng-template>
      </div>`,
  }),
};

/**
 * The problem this exists to solve, shown rather than described.
 *
 * The layer here is a plain `position: absolute` child, the way the composer's pickers are
 * today. The scrolling ancestor clips it. Nothing about the layer is wrong — it is the box
 * around it, which is a box nobody thinks about until a picker is cut in half.
 */
export const Clipped: Story = {
  render: () => ({
    template: `
      <div class="h-40 w-96 overflow-hidden border border-border p-2">
        <p class="text-sm">An ancestor with overflow: hidden.</p>
        <div class="relative mt-2">
          <div class="w-80 rounded-md border border-border p-2 text-sm">Message #general</div>
          <div class="absolute bottom-[calc(100%+4px)] right-0">
            ${layer('Clipped: only the bottom of this is visible.')}
          </div>
        </div>
      </div>`,
  }),
};
