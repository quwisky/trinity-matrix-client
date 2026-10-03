import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  viewChild,
} from '@angular/core';
import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  provideTrnIcons,
  TrnIconComponent,
} from '@trinity/components/foundations';
import { QrCodeService } from '@trinity/platform-native';
import { TrnActionAvailability, TrnButton } from './button/trn-button';
import type {
  TrnButtonPresentation,
  TrnButtonShape,
  TrnButtonSize,
  TrnButtonVariant,
} from './button/trn-button-recipe';
import { TrnCheckboxComponent } from './checkbox/trn-checkbox.component';
import { TrnEmojiPickerComponent } from './emoji-picker/trn-emoji-picker/trn-emoji-picker.component';
import type { TrnEmojiPickerSize } from './emoji-picker/trn-emoji-picker/trn-emoji-picker-recipe';
import { TrnFieldLabelComponent } from './field/field-label/trn-field-label.component';
import { TrnFieldComponent } from './field/field/trn-field.component';
import type { TrnFieldLabelEmphasis } from './field/trn-field-recipe';
import { TrnInput } from './input/trn-input';
import type { TrnTextControlSize } from './input/trn-text-control-recipe';
import { TrnLabel } from './label/trn-label';
import { QrScannerComponent } from './qr-scanner/qr-scanner/qr-scanner.component';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from './radio-group/trn-radio-group.component';
import type { TrnRadioGroupLayout } from './radio-group/trn-radio-group-recipe';
import {
  TrnSelectComponent,
  type TrnSelectOption,
  type TrnSelectSize,
} from './select/trn-select.component';
import { TrnSwitchComponent } from './switch/trn-switch.component';
import { TrnTextarea } from './textarea/trn-textarea';

const completeCatalog =
  <Union>() =>
  <const Values extends readonly Union[]>(
    values: Values & ([Union] extends [Values[number]] ? unknown : never),
  ): Values =>
    values;

const BUTTON_VARIANTS = completeCatalog<TrnButtonVariant>()([
  'primary',
  'secondary',
  'danger',
]);
const BUTTON_SIZES = completeCatalog<TrnButtonSize>()(['xs', 'sm', 'md', 'lg']);
const BUTTON_PRESENTATIONS = completeCatalog<TrnButtonPresentation>()([
  'solid',
  'outline',
  'ghost',
  'link',
]);
const BUTTON_SHAPES = completeCatalog<TrnButtonShape>()(['label', 'icon']);
const RADIO_LAYOUTS = completeCatalog<TrnRadioGroupLayout>()([
  'list',
  'segmented',
]);
const FIELD_LABEL_EMPHASES = completeCatalog<TrnFieldLabelEmphasis>()([
  'normal',
  'strong',
]);
const TEXT_CONTROL_SIZES = completeCatalog<TrnTextControlSize>()([
  'sm',
  'md',
  'lg',
]);
const SELECT_SIZES = completeCatalog<TrnSelectSize>()(['sm', 'md']);
const EMOJI_PICKER_SIZES = completeCatalog<TrnEmojiPickerSize>()([
  'sm',
  'md',
  'lg',
]);

const RADIO_OPTIONS: readonly TrnRadioOption<string>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  {
    value: 'dark',
    label: 'Dark with a deliberately long translated option label',
  },
];

const SELECT_OPTIONS: readonly TrnSelectOption<string>[] = [
  { value: 'compact', label: 'Compact' },
  {
    value: 'comfortable',
    label: 'Comfortable with a deliberately long translated label',
    description: 'Keeps more breathing room around every message.',
  },
  { value: 'disabled', label: 'Unavailable choice', disabled: true },
];

const QR_STORY_SERVICE = {
  openCamera: () =>
    Promise.reject(
      new DOMException('No camera was found on this device.', 'NotFoundError'),
    ),
  closeCamera: () => undefined,
  decodeFrame: () => null,
} satisfies Pick<QrCodeService, 'closeCamera' | 'decodeFrame' | 'openCamera'>;

const QR_STARTING_STORY_SERVICE = {
  openCamera: () => new Promise<MediaStream>(() => undefined),
  closeCamera: () => undefined,
  decodeFrame: () => null,
} satisfies Pick<QrCodeService, 'closeCamera' | 'decodeFrame' | 'openCamera'>;

@Component({
  selector: 'trn-qr-starting-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QrScannerComponent],
  providers: [{ provide: QrCodeService, useValue: QR_STARTING_STORY_SERVICE }],
  template: `<div class="max-w-md p-4">
    <trn-qr-scanner data-testid="catalog-qr-state" />
  </div>`,
})
class QrStartingStoryComponent {}

@Component({
  selector: 'trn-qr-scanning-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QrScannerComponent],
  providers: [{ provide: QrCodeService, useValue: QR_STARTING_STORY_SERVICE }],
  template: `<div class="max-w-md p-4">
    <trn-qr-scanner data-testid="catalog-qr-state" />
  </div>`,
})
class QrScanningStoryComponent implements AfterViewInit {
  private readonly scanner = viewChild.required(QrScannerComponent);

  ngAfterViewInit(): void {
    this.scanner().status.set('scanning');
  }
}

const meta: Meta = {
  title: 'Components/Control recipe matrix',
  decorators: [
    applicationConfig({
      providers: [
        provideTrnIcons(),
        { provide: QrCodeService, useValue: QR_STORY_SERVICE },
      ],
    }),
    moduleMetadata({
      imports: [
        QrScannerComponent,
        QrScanningStoryComponent,
        QrStartingStoryComponent,
        TrnActionAvailability,
        TrnButton,
        TrnCheckboxComponent,
        TrnEmojiPickerComponent,
        TrnFieldComponent,
        TrnFieldLabelComponent,
        TrnIconComponent,
        TrnInput,
        TrnLabel,
        TrnRadioGroupComponent,
        TrnSelectComponent,
        TrnSwitchComponent,
        TrnTextarea,
      ],
    }),
  ],
};

export default meta;
type Story = StoryObj;

/** The complete public Controls treatment inventory in one Theme-aware canvas. */
export const CompleteCatalog: Story = {
  render: () => ({
    props: {
      buttonPresentations: BUTTON_PRESENTATIONS,
      buttonShapes: BUTTON_SHAPES,
      buttonSizes: BUTTON_SIZES,
      buttonVariants: BUTTON_VARIANTS,
      fieldLabelEmphases: FIELD_LABEL_EMPHASES,
      radioLayouts: RADIO_LAYOUTS,
      radioOptions: RADIO_OPTIONS,
      selectOptions: SELECT_OPTIONS,
      selectSizes: SELECT_SIZES,
      textControlSizes: TEXT_CONTROL_SIZES,
    },
    template: `
      <main class="grid min-w-0 gap-10 p-6" data-testid="complete-controls-catalog">
        <h1 class="text-xl font-semibold">Controls catalog</h1>

        <section class="grid gap-4" aria-labelledby="catalog-buttons">
          <h2 id="catalog-buttons" class="text-lg font-semibold">Buttons</h2>
          @for (variant of buttonVariants; track variant) {
            <div class="flex flex-wrap items-center gap-3">
              @for (presentation of buttonPresentations; track presentation) {
                <button
                  [attr.data-testid]="'catalog-button-' + variant + '-' + presentation"
                  data-catalog-touch
                  trnBtn
                  [variant]="variant"
                  [presentation]="presentation"
                >
                  {{ variant }} {{ presentation }}
                </button>
              }
            </div>
          }
          <div class="flex flex-wrap items-center gap-3">
            @for (size of buttonSizes; track size) {
              <button [attr.data-testid]="'catalog-button-size-' + size" data-catalog-touch trnBtn [size]="size">
                {{ size }} button
              </button>
            }
          </div>
          <div class="flex flex-wrap items-center gap-3">
            @for (shape of buttonShapes; track shape) {
              <button
                [attr.data-testid]="'catalog-button-shape-' + shape"
                data-catalog-touch
                trnBtn
                [shape]="shape"
                [attr.aria-label]="shape === 'icon' ? 'Search rooms' : null"
              >
                @if (shape === 'icon') {
                  <trn-icon name="search" motion="pop" />
                } @else {
                  Label button
                }
              </button>
            }
          </div>
          <div class="flex max-w-sm flex-wrap items-center gap-3">
            <button data-testid="catalog-button-loading" data-catalog-touch trnBtn loading disabled>Saving settings</button>
            <button data-testid="catalog-button-disabled" data-catalog-touch trnBtn variant="secondary" disabled>Disabled action</button>
            <button
              data-testid="catalog-button-readonly"
              data-catalog-touch
              trnBtn
              variant="secondary"
              presentation="outline"
              [trnActionAllowed]="false"
              trnActionDisabledReason="Only room owners can archive this room."
            >
              Archive this room with a deliberately long translated label
            </button>
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-choice-controls">
          <h2 id="catalog-choice-controls" class="text-lg font-semibold">Choice controls</h2>
          <div class="flex flex-wrap items-center gap-4">
            <label class="flex items-center gap-2">
              <trn-checkbox data-testid="catalog-checkbox-checked" data-catalog-touch checked />
              Checked checkbox
            </label>
            <label class="flex items-center gap-2">
              <trn-switch data-testid="catalog-switch-checked" data-catalog-touch checked />
              Checked switch
            </label>
          </div>
          <div class="flex flex-wrap items-center gap-4">
            <label class="flex items-center gap-2">
              <trn-checkbox data-testid="catalog-checkbox-rest" data-catalog-touch />
              Resting checkbox
            </label>
            <label class="flex items-center gap-2">
              <trn-switch data-testid="catalog-switch-rest" data-catalog-touch />
              Resting switch
            </label>
            <label class="flex items-center gap-2">
              <trn-checkbox data-testid="catalog-checkbox-indeterminate" data-catalog-touch indeterminate />
              Mixed checkbox
            </label>
            <label class="flex items-center gap-2">
              <trn-checkbox data-testid="catalog-checkbox-invalid" data-catalog-touch invalid aria-describedby="catalog-checkbox-error" />
              Invalid checkbox
            </label>
            <span id="catalog-checkbox-error" class="text-danger">Choose at least one option.</span>
            <label class="flex items-center gap-2">
              <trn-checkbox data-testid="catalog-checkbox-disabled" data-catalog-touch checked disabled />
              Disabled checkbox
            </label>
            <label class="flex items-center gap-2">
              <trn-switch data-testid="catalog-switch-disabled" data-catalog-touch checked disabled />
              Disabled switch
            </label>
          </div>

          @for (layout of radioLayouts; track layout) {
            <trn-radio-group
              [attr.data-testid]="'catalog-radio-' + layout"
              [attr.aria-label]="layout + ' mode'"
              [layout]="layout"
              [options]="radioOptions"
              value="system"
            />
          }
          <trn-radio-group
            data-testid="catalog-radio-invalid"
            aria-label="Invalid mode"
            [options]="radioOptions"
            invalid
          />
          <trn-radio-group
            data-testid="catalog-radio-disabled"
            aria-label="Disabled mode"
            [options]="radioOptions"
            value="system"
            disabled
          />
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-fields">
          <h2 id="catalog-fields" class="text-lg font-semibold">Fields and rich controls</h2>
          @for (emphasis of fieldLabelEmphases; track emphasis) {
            <trn-field>
              <trn-field-label [controlId]="'catalog-label-' + emphasis" [emphasis]="emphasis">
                {{ emphasis }} label
              </trn-field-label>
              <input [id]="'catalog-label-' + emphasis" trnInput [attr.data-testid]="'catalog-label-input-' + emphasis" value="Native label association" />
            </trn-field>
          }
          <label trnLabel for="catalog-direct-label">Direct label</label>
          <input id="catalog-direct-label" trnInput value="Direct label association" />

          <div class="grid gap-4 md:grid-cols-3">
            @for (size of textControlSizes; track size) {
              <label class="grid gap-2">
                {{ size }} input
                <input
                  [attr.data-testid]="'catalog-input-' + size"
                  data-catalog-touch
                  trnInput
                  [size]="size"
                  [value]="'A deliberately long value that remains available at ' + size + ' size'"
                />
              </label>
              <label class="grid gap-2">
                {{ size }} textarea
                <textarea [attr.data-testid]="'catalog-textarea-' + size" data-catalog-touch trnTextarea [size]="size">A deliberately long multi-line value that remains readable.</textarea>
              </label>
            }
          </div>
          <div class="grid gap-4 md:grid-cols-3">
            <label class="grid gap-2">
              Invalid input
              <input data-testid="catalog-input-invalid" data-catalog-touch trnInput invalid aria-describedby="catalog-input-error" value="not a server" />
            </label>
            <p id="catalog-input-error" class="text-danger">Enter a valid server name.</p>
            <label class="grid gap-2">
              Invalid textarea
              <textarea data-testid="catalog-textarea-invalid" data-catalog-touch trnTextarea invalid aria-describedby="catalog-input-error">not a valid description</textarea>
            </label>
            <label class="grid gap-2">
              Read-only input
              <input data-testid="catalog-input-readonly" data-catalog-touch trnInput readonly value="Cannot be edited" />
            </label>
            <label class="grid gap-2">
              Disabled input
              <input data-testid="catalog-input-disabled" data-catalog-touch trnInput disabled value="Unavailable" />
            </label>
            <label class="grid gap-2">
              Read-only textarea
              <textarea data-testid="catalog-textarea-readonly" data-catalog-touch trnTextarea readonly>Cannot be edited</textarea>
            </label>
            <label class="grid gap-2">
              Disabled textarea
              <textarea data-testid="catalog-textarea-disabled" data-catalog-touch trnTextarea disabled>Unavailable</textarea>
            </label>
          </div>

          @for (size of selectSizes; track size) {
            <div class="grid max-w-md gap-2">
              <span trnLabel [id]="'catalog-select-label-' + size">{{ size }} select</span>
              <trn-select
                [attr.data-testid]="'catalog-select-' + size"
                [aria-labelledby]="'catalog-select-label-' + size"
                [options]="selectOptions"
                [size]="size"
                value="comfortable"
              />
            </div>
          }
          <div class="grid max-w-md gap-2">
            <span trnLabel id="catalog-select-invalid-label" invalid>Invalid select</span>
            <trn-select
              data-testid="catalog-select-invalid"
              aria-labelledby="catalog-select-invalid-label"
              [options]="selectOptions"
              invalid
              placeholder="Choose density"
            />
          </div>
          <div class="grid max-w-md gap-2">
            <span trnLabel id="catalog-select-disabled-label">Disabled select</span>
            <trn-select
              data-testid="catalog-select-disabled"
              aria-labelledby="catalog-select-disabled-label"
              [options]="selectOptions"
              value="compact"
              disabled
            />
          </div>

          <div class="grid min-w-0 gap-2">
            <h3 class="font-semibold">Emoji picker</h3>
            <trn-emoji-picker data-testid="catalog-emoji-md" pickerId="catalog-emoji-md" size="md" />
          </div>

          <div class="max-w-md">
            <h3 class="mb-2 font-semibold">QR scanner error</h3>
            <trn-qr-scanner data-testid="catalog-qr-scanner" />
          </div>
        </section>
      </main>
    `,
  }),
};

const emojiPickerStory = (size: TrnEmojiPickerSize): Story => ({
  render: () => ({
    props: { size },
    template: `
      <div class="grid min-w-0 gap-2 p-4">
        <h1 class="font-semibold">{{ size }} emoji picker</h1>
        <trn-emoji-picker data-testid="catalog-emoji-size" pickerId="catalog-emoji-size" [size]="size" />
      </div>
    `,
  }),
});

// Keep each size in its own canvas so the vendor's named search landmark stays unique.
export const EmojiPickerSmall = emojiPickerStory(EMOJI_PICKER_SIZES[0]);
export const EmojiPickerMedium = emojiPickerStory(EMOJI_PICKER_SIZES[1]);
export const EmojiPickerLarge = emojiPickerStory(EMOJI_PICKER_SIZES[2]);

export const QrScannerStarting: Story = {
  render: () => ({ template: '<trn-qr-starting-story />' }),
};
export const QrScannerScanning: Story = {
  render: () => ({ template: '<trn-qr-scanning-story />' }),
};
