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

/**
 * The encryption prompt's shape: solid actions on the attention surface, including an anchor,
 * which needs its own hover rule. They invert to the on-attention action roles, so each reads
 * as a button with a visible hover and focus.
 */
export const AccentActions: Story = {
  render: () => ({
    template: `
      <trn-banner variant="accent">
        <trn-icon trnBannerIcon name="lock" />
        Verify this device to read your encrypted messages.
        <span trnBannerActions>
          <button trnBtn size="sm">Verify with another device</button>
          <button trnBtn size="sm">Use recovery key</button>
          <a trnBtn size="sm" href="#">Learn more</a>
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

/**
 * The two banners that take turns in the app's global slot: the limited-capability notice
 * (two actions) and the encryption prompt (one). `placement="global"` gives them one height
 * below md, where the two actions wrap under the message, so replacing one with the other
 * never moves the page below.
 */
export const GlobalSlot: Story = {
  render: () => ({
    template: `
      <div class="grid gap-4">
        <trn-banner variant="neutral" placement="global" data-testid="global-status">
          Protected browser storage is unavailable.
          <span trnBannerActions>
            <button trnBtn presentation="outline" size="sm">System status</button>
            <button trnBtn presentation="ghost" size="sm">Dismiss</button>
          </span>
        </trn-banner>
        <trn-banner variant="accent" placement="global" data-testid="global-prompt">
          <trn-icon trnBannerIcon name="lock" />
          Set up encryption to secure your messages.
          <span trnBannerActions>
            <button trnBtn size="sm">Set up</button>
          </span>
        </trn-banner>
      </div>`,
  }),
};

/** Message search's server-search prompt: a lone action, with no icon or message. */
export const ActionOnly: Story = {
  render: () => ({
    template: `
      <trn-banner variant="neutral">
        <span trnBannerActions>
          <button trnBtn variant="secondary" presentation="outline" size="sm">
            <trn-icon name="server" />
            Search all messages
          </button>
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
