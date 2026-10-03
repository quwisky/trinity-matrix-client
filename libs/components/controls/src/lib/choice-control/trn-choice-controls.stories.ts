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
import { TrnCheckboxComponent } from '../checkbox/trn-checkbox.component';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '../radio-group/trn-radio-group.component';
import { TrnSwitchComponent } from '../switch/trn-switch.component';

const OPTIONS: readonly TrnRadioOption<string>[] = [
  { value: 'system', label: 'System', testId: 'radio-system' },
  { value: 'light', label: 'Light', testId: 'radio-light' },
  { value: 'dark', label: 'Dark', testId: 'radio-dark' },
];

const meta: Meta<TrnCheckboxComponent> = {
  title: 'Components/Choice controls',
  component: TrnCheckboxComponent,
  decorators: [
    applicationConfig({ providers: [provideTrnIcons()] }),
    moduleMetadata({
      imports: [
        TrnCheckboxComponent,
        TrnIconComponent,
        TrnRadioGroupComponent,
        TrnSwitchComponent,
      ],
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Binary and exclusive controls use a single Trinity treatment. ' +
          'Radio layout is the only structural axis.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnCheckboxComponent>;

/** Canonical recipes together with the interaction states each family genuinely owns. */
export const CanonicalStates: Story = {
  render: () => ({
    props: {
      checkboxChecked: true,
      options: OPTIONS,
      selected: 'system',
      switchChecked: true,
    },
    template: `
      <div class="grid max-w-lg gap-6 p-4">
        <div class="flex flex-wrap items-center gap-4">
          <label class="flex items-center gap-2">
            <trn-checkbox
              data-testid="checkbox-accent"
              [checked]="checkboxChecked"
              (checkedChange)="checkboxChecked = $event"
            />
            Accent checkbox
          </label>
          <label class="flex items-center gap-2">
            <trn-checkbox
              data-testid="checkbox-invalid"
              invalid
              aria-describedby="checkbox-error"
            />
            Invalid checkbox
          </label>
          <span id="checkbox-error">Choose at least one option.</span>
        </div>

        <div class="flex flex-wrap items-center gap-4">
          <label class="flex items-center gap-2">
            <trn-switch
              data-testid="switch-accent"
              [checked]="switchChecked"
              (checkedChange)="switchChecked = $event"
            />
            Accent switch
          </label>
          <label class="flex items-center gap-2">
            <trn-switch data-testid="switch-disabled" disabled />
            Disabled switch
          </label>
        </div>

        <section>
          <h2 id="theme-choice">Theme</h2>
          <trn-radio-group
            data-testid="radio-canonical"
            layout="segmented"
            aria-labelledby="theme-choice"
            [options]="options"
            [value]="selected"
            (valueChange)="selected = $event"
          />
        </section>
      </div>
    `,
  }),
};
