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
import { TrnToggleDirective } from '../toggle/trn-toggle.directive';
import { TrnToggleGroupItemDirective } from '../toggle-group/trn-toggle-group-item.directive';
import { TrnToggleGroupComponent } from '../toggle-group/trn-toggle-group.component';

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
        TrnToggleDirective,
        TrnToggleGroupComponent,
        TrnToggleGroupItemDirective,
      ],
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Binary, exclusive and pressed-state controls use Trinity semantic tones and ' +
          'ordinal sizes. Layout, presentation and semantic variant stay separate axes.',
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
              variant="accent"
              size="md"
              [checked]="checkboxChecked"
              (checkedChange)="checkboxChecked = $event"
            />
            Accent checkbox
          </label>
          <label class="flex items-center gap-2">
            <trn-checkbox
              data-testid="checkbox-invalid"
              variant="neutral"
              size="sm"
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
              variant="accent"
              size="md"
              [checked]="switchChecked"
              (checkedChange)="switchChecked = $event"
            />
            Accent switch
          </label>
          <label class="flex items-center gap-2">
            <trn-switch data-testid="switch-disabled" disabled variant="neutral" size="sm" />
            Disabled switch
          </label>
        </div>

        <section>
          <h2 id="theme-choice">Theme</h2>
          <trn-radio-group
            data-testid="radio-canonical"
            layout="segmented"
            variant="accent"
            size="md"
            aria-labelledby="theme-choice"
            [options]="options"
            [value]="selected"
            (valueChange)="selected = $event"
          />
        </section>

        <div class="flex flex-wrap items-center gap-3">
          <button data-testid="toggle-idle" trnToggle variant="neutral" size="sm">
            Idle
          </button>
          <button data-testid="toggle-selected" trnToggle variant="accent" size="md" [pressed]="true">
            Selected
          </button>
          <button data-testid="toggle-readonly" trnToggle variant="neutral" size="md" [pressed]="true" readOnly>
            Read only
          </button>
          <button data-testid="toggle-disabled" trnToggle variant="neutral" size="lg" disabled>
            Disabled
          </button>
        </div>

        <trn-toggle-group
          data-testid="toggle-group-canonical"
          type="single"
          value="grid"
          variant="neutral"
          presentation="outline"
          size="md"
          arrangement="joined"
          aria-label="Layout"
        >
          <button trnToggleGroupItem value="list">List</button>
          <button trnToggleGroupItem value="grid">Grid</button>
          <button trnToggleGroupItem value="compact" disabled>Compact</button>
        </trn-toggle-group>
      </div>
    `,
  }),
};

/** Temporary aliases keep existing templates operational while consumers migrate. */
export const CompatibilityAliases: Story = {
  render: () => ({
    props: { options: OPTIONS },
    template: `
      <div class="grid max-w-lg gap-5 p-4">
        <trn-radio-group
          data-testid="radio-legacy-layout"
          variant="segmented"
          aria-label="Compatibility theme"
          [options]="options"
          value="system"
        />
        <trn-toggle-group
          data-testid="toggle-group-legacy"
          type="single"
          value="week"
          variant="outline"
          size="default"
          aria-label="Compatibility range"
        >
          <button trnToggleGroupItem value="day">Day</button>
          <button trnToggleGroupItem value="week">Week</button>
          <button trnToggleGroupItem value="month">Month</button>
        </trn-toggle-group>
      </div>
    `,
  }),
};
