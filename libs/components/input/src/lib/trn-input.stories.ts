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
