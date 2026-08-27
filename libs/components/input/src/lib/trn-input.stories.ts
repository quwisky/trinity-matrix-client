import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { HlmInput } from '@trinity/helm/input';
import { TrnInput } from './trn-input';

const meta: Meta<TrnInput> = {
  title: 'Components/Input',
  component: TrnInput,
  parameters: { layout: 'centered' },
  decorators: [
    (story) => ({
      ...story(),
      moduleMetadata: { imports: [HlmInput] },
    }),
  ],
};

export default meta;
type Story = StoryObj<TrnInput>;

/** The public wrapper owns one focus ring through its Helm host directive. */
export const Default: Story = {
  render: () => ({
    template: `<input trnInput aria-label="Room name" placeholder="Room name" />`,
  }),
};

/** The alert prompt's direct Helm path has the same owned-focus contract. */
export const DirectHelmPrompt: Story = {
  render: () => ({
    template: `<input hlmInput aria-label="Prompt response" placeholder="Type a response" />`,
  }),
};
