import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { BannerComponent } from './banner.component';

/**
 * Everything in this component is projected — icon, message, actions — so the stories render
 * a template rather than binding args. That is the point: the tone is the only thing the
 * component decides, and the only way to see whether a variant works is to put real content in
 * it and switch the Theme.
 */
const meta: Meta<BannerComponent> = {
  title: 'Components/Banner',
  component: BannerComponent,
  decorators: [
    (story) => ({
      ...story(),
      // `TrnButton` as well as the icon: the projected actions are plain <button trnBtn>
      // elements, and without the directive here they render as unstyled browser buttons —
      // which is precisely the part of the layout these stories exist to show.
      moduleMetadata: { imports: [TrnIconComponent, TrnButton] },
    }),
  ],
};

export default meta;
type Story = StoryObj<BannerComponent>;

export const Neutral: Story = {
  // Passive status: something is true, nothing is being asked of you.
  render: () => ({
    template: `
      <trn-banner variant="neutral">
        <trn-icon trnBannerIcon name="cloud-off" />
        You are offline. Messages will send when the connection returns.
      </trn-banner>`,
  }),
};

export const Accent: Story = {
  // A call to action, which is why it carries a button and the louder tone.
  render: () => ({
    template: `
      <trn-banner variant="accent">
        <trn-icon trnBannerIcon name="lock" />
        Set up encryption to secure your messages.
        <span trnBannerActions>
          <button trnBtn size="sm">Set up</button>
        </span>
      </trn-banner>`,
  }),
};

export const LongMessage: Story = {
  // The state a screenshot never covers and a narrow window always finds: the text has to
  // wrap without pushing the actions off the end or crushing the icon.
  render: () => ({
    template: `
      <trn-banner variant="neutral">
        <trn-icon trnBannerIcon name="eye-off" />
        This room's history is only visible to members who joined before you, so the messages
        above may be missing context that other people in the room can see.
        <span trnBannerActions>
          <button trnBtn size="sm">Learn more</button>
        </span>
      </trn-banner>`,
  }),
};

export const NoActions: Story = {
  render: () => ({
    template: `
      <trn-banner variant="neutral">
        <trn-icon trnBannerIcon name="loader-circle" />
        Reconnecting…
      </trn-banner>`,
  }),
};

/** Disabled actions keep native semantics and use the shared disabled recipe. */
export const DisabledAction: Story = {
  render: () => ({
    template: `
      <trn-banner variant="neutral">
        <trn-icon trnBannerIcon name="cloud-off" />
        Reconnecting before this action becomes available.
        <span trnBannerActions>
          <button trnBtn size="sm" disabled>Retry now</button>
        </span>
      </trn-banner>`,
  }),
};

/** The same component under the root-level density contract. */
export const Compact: Story = {
  globals: { density: 'compact' },
  render: () => ({
    template: `
      <trn-banner variant="neutral">
        <trn-icon trnBannerIcon name="loader-circle" />
        Compact density keeps status chrome quiet.
      </trn-banner>`,
  }),
};
