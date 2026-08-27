import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnTextarea } from './trn-textarea';

const meta: Meta<TrnTextarea> = {
  title: 'Components/Textarea',
  component: TrnTextarea,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<TrnTextarea>;

/** The public wrapper owns one focus ring through its Helm host directive. */
export const Default: Story = {
  render: () => ({
    template: `<textarea trnTextarea aria-label="Room topic" placeholder="Room topic"></textarea>`,
  }),
};
