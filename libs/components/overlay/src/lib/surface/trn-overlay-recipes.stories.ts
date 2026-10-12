import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  TrnButton,
  TrnCheckboxComponent,
  TrnInput,
  TrnRadioGroupComponent,
  TrnSelectComponent,
  TrnSwitchComponent,
  TrnTextarea,
  type TrnRadioOption,
  type TrnSelectOption,
} from '@trinity/components/controls';
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

const VERIFY_METHODS: readonly TrnRadioOption<string>[] = [
  { value: 'device', label: 'Another device' },
  { value: 'key', label: 'Recovery key' },
];
const REMINDERS: readonly TrnSelectOption<string>[] = [
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'Next week' },
];
const BACKUP_METHODS: readonly TrnRadioOption<string>[] = [
  { value: 'key', label: 'Recovery key', description: 'Save a key you keep' },
  { value: 'phrase', label: 'Passphrase', description: 'Remember a phrase' },
];
const KEY_STORAGE: readonly TrnRadioOption<string>[] = [
  { value: 'device', label: 'This device', description: 'Stays here' },
  { value: 'server', label: 'Server', description: 'Encrypted backup' },
];

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
        TrnButton,
        TrnCheckboxComponent,
        TrnInput,
        TrnOverlaySurfaceDirective,
        TrnRadioGroupComponent,
        TrnSelectComponent,
        TrnSwitchComponent,
        TrnTextarea,
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

/**
 * An accent dialog with its own primary action, an anchor and a ghost action. The surface
 * marks itself as an attention surface, so the solid actions invert to the on-attention roles
 * instead of an accent fill that would vanish on the accent ground. Every focusable inside,
 * the transparent text field included, sits on the accent and uses the on-attention ring.
 * The field, the segmented choice and the select use the attention control roles for their
 * value, placeholder, resting border and track.
 */
export const AccentSurface: Story = {
  render: () => ({
    props: {
      methods: VERIFY_METHODS,
      method: 'device',
      reminders: REMINDERS,
      reminder: null,
    },
    template: `
      <div class="p-6">
        <section
          trnOverlaySurface
          variant="accent"
          size="md"
          layout="dialog"
          class="grid gap-4 p-6"
          aria-labelledby="accent-surface-title"
          data-testid="accent-overlay-surface"
        >
          <h2 id="accent-surface-title" class="text-lg font-semibold">Verify this device</h2>
          <p class="text-sm">Verify this device to read your encrypted messages.</p>
          <input trnInput aria-label="Recovery key" placeholder="Recovery key" />
          <trn-radio-group
            layout="segmented"
            aria-label="Verify with"
            [options]="methods"
            [value]="method"
            (valueChange)="method = $event"
          />
          <span id="accent-surface-reminder" class="sr-only">Remind me</span>
          <trn-select
            aria-labelledby="accent-surface-reminder"
            placeholder="Remind me later"
            [options]="reminders"
            [value]="reminder"
            (valueChange)="reminder = $event"
          />
          <div class="flex flex-wrap justify-end gap-2">
            <button trnBtn presentation="ghost" size="sm" type="button">Not now</button>
            <a trnBtn size="sm" href="#">Learn more</a>
            <button trnBtn size="sm" type="button">Verify now</button>
          </div>
        </section>
      </div>
    `,
  }),
};

/**
 * The remaining controls on an accent dialog: an outline action, a checkbox and a switch
 * (their checked fills invert like a solid action), a list radio group and a segmented group
 * with option descriptions, a file input, and invalid field, textarea, select and checkbox
 * states. Each uses the attention control roles. The invalid states take the attention danger
 * role, which keeps 3:1 against the accent, plus a 2px ring that does not rely on hue; their
 * messages inherit the surface's foreground.
 */
export const AccentSurfaceControls: Story = {
  render: () => ({
    props: {
      backupMethods: BACKUP_METHODS,
      backupMethod: 'key',
      storage: KEY_STORAGE,
      storageChoice: 'device',
      reminders: REMINDERS,
      reminder: null,
      remember: false,
      sync: false,
    },
    template: `
      <div class="p-6">
        <section
          trnOverlaySurface
          variant="accent"
          size="md"
          layout="dialog"
          class="grid gap-4 p-6"
          aria-labelledby="accent-controls-title"
          data-testid="accent-overlay-controls"
        >
          <h2 id="accent-controls-title" class="text-lg font-semibold">Set up secure backup</h2>
          <trn-radio-group
            aria-label="Back up with"
            [options]="backupMethods"
            [value]="backupMethod"
            (valueChange)="backupMethod = $event"
          />
          <trn-radio-group
            layout="segmented"
            aria-label="Keep the key on"
            [options]="storage"
            [value]="storageChoice"
            (valueChange)="storageChoice = $event"
          />
          <div class="grid gap-1">
            <input
              trnInput
              explicitInvalid
              aria-label="Passphrase"
              aria-describedby="accent-controls-passphrase-error"
              value="short"
            />
            <span id="accent-controls-passphrase-error" class="text-sm">Use at least 12 characters</span>
          </div>
          <div class="grid gap-1">
            <textarea
              trnTextarea
              explicitInvalid
              aria-label="Backup note"
              aria-describedby="accent-controls-note-error"
            ></textarea>
            <span id="accent-controls-note-error" class="text-sm">Add a note</span>
          </div>
          <span id="accent-controls-reminder" class="sr-only">Remind me</span>
          <trn-select
            invalid
            aria-labelledby="accent-controls-reminder"
            placeholder="Remind me later"
            [options]="reminders"
            [value]="reminder"
            (valueChange)="reminder = $event"
          />
          <input trnInput type="file" aria-label="Key file" />
          <div class="flex flex-wrap gap-4">
            <label class="flex items-center gap-1 text-sm">
              <trn-checkbox [checked]="remember" (checkedChange)="remember = $event" />
              Remember this device
            </label>
            <label class="flex items-center gap-1 text-sm">
              <trn-checkbox invalid />
              I saved my key
            </label>
            <label class="flex items-center gap-1 text-sm">
              <trn-switch [checked]="sync" (checkedChange)="sync = $event" />
              Sync keys
            </label>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <button trnBtn presentation="outline" size="sm" type="button">Export key</button>
            <button trnBtn size="sm" type="button">Continue</button>
          </div>
        </section>
      </div>
    `,
  }),
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
