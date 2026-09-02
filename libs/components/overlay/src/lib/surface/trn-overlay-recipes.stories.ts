import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { provideTrnOverlayDefaults } from '../provide-overlay-defaults';
import { DialogOverlayStoryComponent } from './stories/dialog-overlay-story/dialog-overlay-story.component';
import { DropdownOverlayStoryComponent } from './stories/dropdown-overlay-story/dropdown-overlay-story.component';
import { FeedbackOverlayStoryComponent } from './stories/feedback-overlay-story/feedback-overlay-story.component';
import { LayeredOverlayStoryComponent } from './stories/layered-overlay-story/layered-overlay-story.component';
import {
  type TrnOverlaySurfaceLayout,
  type TrnOverlaySurfaceSize,
  type TrnOverlaySurfaceVariant,
} from './trn-overlay-surface-recipe';
import { TrnOverlaySurfaceDirective } from './trn-overlay-surface.directive';

const completeCatalog =
  <Union>() =>
  <const Values extends readonly Union[]>(
    values: Values & ([Union] extends [Values[number]] ? unknown : never),
  ): Values =>
    values;

const SURFACE_VARIANTS = completeCatalog<TrnOverlaySurfaceVariant>()([
  'neutral',
  'accent',
]);
const SURFACE_SIZES = completeCatalog<TrnOverlaySurfaceSize>()([
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
]);
const SURFACE_LAYOUTS = completeCatalog<TrnOverlaySurfaceLayout>()([
  'dialog',
  'sheet',
  'popover',
  'panel',
  'workspace',
  'fullscreen',
]);

const meta: Meta = {
  title: 'Components/Overlay recipes',
  decorators: [
    applicationConfig({ providers: [provideTrnOverlayDefaults()] }),
    moduleMetadata({
      imports: [
        DialogOverlayStoryComponent,
        DropdownOverlayStoryComponent,
        FeedbackOverlayStoryComponent,
        LayeredOverlayStoryComponent,
        TrnOverlaySurfaceDirective,
      ],
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Trinity-owned overlay treatment, placement, and lifecycle across document and portal surfaces.',
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const LayeredSurfaces: Story = {
  render: () => ({ template: '<trn-layered-overlay-story />' }),
};

export const Dropdowns: Story = {
  render: () => ({ template: '<trn-dropdown-overlay-story />' }),
};

export const Dialogs: Story = {
  render: () => ({ template: '<trn-dialog-overlay-story />' }),
};

export const Feedback: Story = {
  render: () => ({ template: '<trn-feedback-overlay-story />' }),
};

/** Every public overlay surface axis plus the interactive lifecycle stories. */
export const CompleteCatalog: Story = {
  render: () => ({
    props: {
      surfaceLayouts: SURFACE_LAYOUTS,
      surfaceSizes: SURFACE_SIZES,
      surfaceVariants: SURFACE_VARIANTS,
    },
    template: `
      <main class="grid min-w-0 gap-10 p-6" data-testid="complete-overlay-catalog">
        <h1 class="text-xl font-semibold">Overlay catalog</h1>

        <section class="grid gap-4" aria-labelledby="catalog-overlay-variants">
          <h2 id="catalog-overlay-variants" class="text-lg font-semibold">Semantic surfaces</h2>
          <div class="flex flex-wrap items-start gap-4">
            @for (variant of surfaceVariants; track variant) {
              <div
                trnOverlaySurface
                [variant]="variant"
                size="sm"
                layout="popover"
                [attr.data-testid]="'catalog-overlay-variant-' + variant"
                class="p-4"
              >
                {{ variant }} surface
              </div>
            }
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-overlay-sizes">
          <h2 id="catalog-overlay-sizes" class="text-lg font-semibold">Ordinal sizes</h2>
          @for (size of surfaceSizes; track size) {
            <div
              trnOverlaySurface
              variant="neutral"
              [size]="size"
              layout="dialog"
              [attr.data-testid]="'catalog-overlay-size-' + size"
              class="max-w-full p-3"
            >
              {{ size }} surface
            </div>
          }
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-overlay-layouts">
          <h2 id="catalog-overlay-layouts" class="text-lg font-semibold">Structural layouts</h2>
          @for (layout of surfaceLayouts; track layout) {
            <div class="h-48 max-w-full overflow-hidden rounded-md border border-border">
              <div
                trnOverlaySurface
                variant="neutral"
                size="sm"
                [layout]="layout"
                [attr.data-testid]="'catalog-overlay-layout-' + layout"
                class="p-3"
              >
                {{ layout }} layout
              </div>
            </div>
          }
        </section>

        <section class="grid gap-3" aria-labelledby="catalog-overlay-layered">
          <h2 id="catalog-overlay-layered" class="text-lg font-semibold">Document and portal</h2>
          <trn-layered-overlay-story />
        </section>
        <section class="grid gap-3" aria-labelledby="catalog-overlay-dropdowns">
          <h2 id="catalog-overlay-dropdowns" class="text-lg font-semibold">Dropdowns</h2>
          <trn-dropdown-overlay-story />
        </section>
        <section class="grid gap-3" aria-labelledby="catalog-overlay-dialogs">
          <h2 id="catalog-overlay-dialogs" class="text-lg font-semibold">Dialogs</h2>
          <trn-dialog-overlay-story />
        </section>
        <section class="grid gap-3" aria-labelledby="catalog-overlay-feedback">
          <h2 id="catalog-overlay-feedback" class="text-lg font-semibold">Alerts, sheets, and toasts</h2>
          <trn-feedback-overlay-story />
        </section>
      </main>
    `,
  }),
};
