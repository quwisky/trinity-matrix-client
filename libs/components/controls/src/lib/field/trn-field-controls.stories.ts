import {
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { TrnEmojiPickerComponent } from '../emoji-picker/trn-emoji-picker/trn-emoji-picker.component';
import { TrnInput } from '../input/trn-input';
import { TrnLabel } from '../label/trn-label';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from '../select/trn-select.component';
import { TrnTextarea } from '../textarea/trn-textarea';
import { TrnFieldLabelComponent } from './field-label/trn-field-label.component';
import { TrnFieldComponent } from './field/trn-field.component';

const OPTIONS: readonly TrnSelectOption<string>[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
];

const meta: Meta<TrnFieldComponent> = {
  title: 'Components/Field controls',
  component: TrnFieldComponent,
  decorators: [
    moduleMetadata({
      imports: [
        TrnEmojiPickerComponent,
        TrnFieldComponent,
        TrnFieldLabelComponent,
        TrnInput,
        TrnLabel,
        TrnSelectComponent,
        TrnTextarea,
      ],
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Native field semantics with explicit emphasis and validation, bounded ordinal control sizes, and Trinity-owned rich-control adapters.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnFieldComponent>;

/** Canonical field, text-entry and selection contracts with their accessible relationships. */
export const CanonicalStates: Story = {
  render: () => ({
    props: { options: OPTIONS, selected: 'comfortable' },
    template: `
      <div class="grid w-[360px] gap-6 p-4">
        <trn-field>
          <trn-field-label controlId="room-name" emphasis="strong">Room name</trn-field-label>
          <input
            trnInput
            id="room-name"
            size="sm"
            placeholder="Trinity HQ"
            data-testid="field-input-small"
          />
        </trn-field>

        <trn-field invalid>
          <trn-field-label controlId="server-name" invalid>Server name</trn-field-label>
          <input
            trnInput
            id="server-name"
            size="md"
            invalid
            aria-describedby="server-name-error"
            value="not a server"
            data-testid="field-input-invalid"
          />
          <p id="server-name-error" class="text-sm text-danger">Enter a valid server name.</p>
        </trn-field>

        <div class="grid gap-2">
          <label trnLabel for="room-topic">Room topic</label>
          <textarea
            trnTextarea
            id="room-topic"
            size="lg"
            aria-describedby="room-topic-help"
            data-testid="field-textarea-large"
          ></textarea>
          <p id="room-topic-help" class="text-sm text-muted-foreground">Shown below the room name.</p>
        </div>

        <div class="grid gap-2">
          <span trnLabel id="density-label">Message density</span>
          <trn-select
            aria-labelledby="density-label"
            size="md"
            [options]="options"
            [value]="selected"
            (valueChange)="selected = $event"
            data-testid="field-select"
          />
        </div>
      </div>
    `,
  }),
};

/** Emoji glyph measurement is selected through Trinity's ordinal vocabulary. */
export const RichControlSize: Story = {
  render: () => ({
    template: `
      <div class="p-4">
        <trn-emoji-picker size="lg" />
      </div>
    `,
  }),
};
