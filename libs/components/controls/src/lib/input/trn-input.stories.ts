import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnInput } from './trn-input';

const meta: Meta<TrnInput> = {
  title: 'Components/Input',
  component: TrnInput,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<TrnInput>;

/** The public wrapper owns one focus ring through its Helm host directive. */
export const Default: Story = {
  render: () => ({
    template: `<input trnInput aria-label="Room name" placeholder="Room name" />`,
  }),
};

/** Every size and state in the composer's look: fill, container radius and inset focus ring. */
export const States: Story = {
  render: () => ({
    template: `
      <div class="grid w-[360px] gap-3">
        <input trnInput size="sm" aria-label="Small" placeholder="Small, 28px" />
        <input trnInput aria-label="Medium" placeholder="Medium, the density's control size" />
        <input trnInput size="lg" aria-label="Large" placeholder="Large, 40px" />
        <input trnInput explicitInvalid aria-label="Invalid" value="not a server" />
        <input trnInput readonly aria-label="Read-only" value="Read-only: solid edge, no fill" />
        <input trnInput disabled aria-label="Disabled" value="Disabled: dashed edge, muted" />
        <input trnInput size="sm" disabled aria-label="Small disabled" value="Small disabled" />
      </div>
    `,
  }),
};
