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

/** The composer's look on multi-line fields, with the invalid, read-only and disabled states. */
export const States: Story = {
  render: () => ({
    template: `
      <div class="grid w-[360px] gap-3">
        <textarea trnTextarea aria-label="Topic" placeholder="Room topic"></textarea>
        <textarea trnTextarea explicitInvalid aria-label="Invalid">Too long</textarea>
        <textarea trnTextarea readonly aria-label="Read-only">Read-only topic</textarea>
        <textarea trnTextarea disabled aria-label="Disabled">Disabled topic</textarea>
      </div>
    `,
  }),
};
