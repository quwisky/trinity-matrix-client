import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  TrnInput,
  TrnPasswordInputComponent,
  TrnSelectComponent,
  TrnTextarea,
} from '@trinity/components/controls';
import { provideTrnIcons } from '@trinity/components/foundations';
import { TrnFieldLockComponent } from './trn-field-lock.component';

const meta: Meta<TrnFieldLockComponent> = {
  title: 'Components/Field lock',
  component: TrnFieldLockComponent,
  decorators: [
    applicationConfig({ providers: [provideTrnIcons()] }),
    moduleMetadata({
      imports: [
        TrnFieldLockComponent,
        TrnInput,
        TrnPasswordInputComponent,
        TrnSelectComponent,
        TrnTextarea,
      ],
    }),
  ],
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<TrnFieldLockComponent>;

/** A disabled field says why through a focusable lock; a small one keeps only the dashed edge. */
export const Disabled: Story = {
  render: () => ({
    template: `
      <div class="grid w-[360px] gap-3 p-12">
        <trn-field-lock>
          <input trnInput disabled aria-label="Display name" value="Ada" data-testid="field-lock-input" />
        </trn-field-lock>
        <trn-field-lock>
          <input
            trnInput
            disabled
            disabledReason="Wait for sign-in to finish"
            aria-label="Username"
            value="ada"
            data-testid="field-lock-username"
          />
        </trn-field-lock>
        <trn-field-lock>
          <trn-password-input>
            <input trnInput disabled aria-label="Password" value="secret" />
          </trn-password-input>
        </trn-field-lock>
        <span id="field-lock-join-label">Who can join</span>
        <trn-field-lock>
          <trn-select
            aria-labelledby="field-lock-join-label"
            [options]="[{ value: 'invite', label: 'Invite only' }]"
            value="invite"
            [disabled]="true"
            disabledReason="Only admins can change who can join"
            data-testid="field-lock-select"
          />
        </trn-field-lock>
        <trn-field-lock>
          <textarea trnTextarea disabled aria-label="Topic">A room topic</textarea>
        </trn-field-lock>
        <trn-field-lock>
          <input trnInput size="sm" disabled aria-label="Filter" value="Small: no lock" />
        </trn-field-lock>
        <trn-field-lock>
          <input trnInput aria-label="Enabled" placeholder="Enabled: no lock" />
        </trn-field-lock>
      </div>
    `,
  }),
};
