import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnIconComponent } from '@trinity/components/icon';
import { BannerComponent } from './banner.component';

/**
 * Everything in this component is projected — icon, message, actions — so the stories render
 * a template rather than binding args. That is the point: the tone is the only thing the
 * component decides, and the only way to see whether a tone works is to put real content in
 * it and flip the palette.
 */
const meta: Meta<BannerComponent> = {
  title: 'Components/Banner',
  component: BannerComponent,
  decorators: [
    (story) => ({
      ...story(),
      moduleMetadata: { imports: [TrnIconComponent] },
    }),
  ],
};

export default meta;
type Story = StoryObj<BannerComponent>;

export const Neutral: Story = {
  // Passive status: something is true, nothing is being asked of you.
  render: () => ({
    template: `
      <trn-banner tone="neutral">
        <trn-icon trnBannerIcon name="wifi-off" />
        You are offline. Messages will send when the connection returns.
      </trn-banner>`,
  }),
};

export const Accent: Story = {
  // A call to action, which is why it carries a button and the louder tone.
  render: () => ({
    template: `
      <trn-banner tone="accent">
        <trn-icon trnBannerIcon name="lock" />
        Set up encryption to secure your messages.
        <span trnBannerActions>
          <button hlmBtn size="sm">Set up</button>
        </span>
      </trn-banner>`,
  }),
};

export const LongMessage: Story = {
  // The state a screenshot never covers and a narrow window always finds: the text has to
  // wrap without pushing the actions off the end or crushing the icon.
  render: () => ({
    template: `
      <trn-banner tone="neutral">
        <trn-icon trnBannerIcon name="triangle-alert" />
        This room's history is only visible to members who joined before you, so the messages
        above may be missing context that other people in the room can see.
        <span trnBannerActions>
          <button hlmBtn size="sm">Learn more</button>
        </span>
      </trn-banner>`,
  }),
};

export const NoActions: Story = {
  render: () => ({
    template: `
      <trn-banner tone="neutral">
        <trn-icon trnBannerIcon name="info" />
        Reconnecting…
      </trn-banner>`,
  }),
};
