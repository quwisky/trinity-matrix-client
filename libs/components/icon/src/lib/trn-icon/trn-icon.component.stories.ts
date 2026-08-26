import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { HlmButton } from '@trinity/helm/button';
import { type TrnIconMotion } from '../trn-icon-motion';
import { provideTrnIcons } from '../trn-icon.icons';
import { TrnIconComponent } from './trn-icon.component';

const meta: Meta<TrnIconComponent> = {
  title: 'Components/Icon motion',
  component: TrnIconComponent,
  decorators: [
    applicationConfig({ providers: [provideTrnIcons()] }),
    moduleMetadata({ imports: [HlmButton, TrnIconComponent] }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Opt-in, transform-only icon gestures driven by the surrounding button. ' +
          'Hover, keyboard focus and press each have feedback; reduced motion keeps the ' +
          'existing button state changes and leaves the glyph static.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnIconComponent>;

const motionButton = (
  motion: TrnIconMotion,
  icon: 'arrow-left' | 'send' | 'settings',
  label: string,
  disabled = false,
) => ({
  template: `
    <div class="flex items-center gap-3 p-4" data-testid="motion-row">
      <button
        type="button"
        hlmBtn
        variant="outline"
        size="icon"
        aria-label="${label}"
        data-testid="motion-button"
        ${disabled ? 'disabled' : ''}
        ${disabled ? 'style="pointer-events: auto"' : ''}
      >
        <trn-icon name="${icon}" motion="${motion}" />
      </button>
      <span data-testid="motion-neighbour">${label}</span>
    </div>`,
});

/** A back affordance nudges toward the destination. */
export const NudgeLeft: Story = {
  render: () => motionButton('nudge-left', 'arrow-left', 'Back'),
};

/** A send affordance moves along the paper-plane's direction of travel. */
export const NudgeUpRight: Story = {
  render: () => motionButton('nudge-up-right', 'send', 'Send'),
};

/** Settings turns slightly without making a full distracting revolution. */
export const Rotate: Story = {
  render: () => motionButton('rotate', 'settings', 'Settings'),
};

/** Disabled controls retain their static glyph even if a pointer crosses them. */
export const Disabled: Story = {
  // The production button style ignores pointer input when disabled. Re-enable hit-testing in
  // this diagnostic story so the browser test proves the icon's own disabled guard as well.
  render: () =>
    motionButton('nudge-up-right', 'send', 'Send unavailable', true),
};

/** The complete supported vocabulary, for quick palette and light/dark review. */
export const AllVariants: Story = {
  render: () => ({
    template: `
      <div class="flex flex-wrap gap-3 p-4">
        <button type="button" hlmBtn variant="outline" aria-label="Back">
          <trn-icon name="arrow-left" motion="nudge-left" />
          Nudge left
        </button>
        <button type="button" hlmBtn variant="outline" aria-label="Send">
          <trn-icon name="send" motion="nudge-up-right" />
          Nudge up-right
        </button>
        <button type="button" hlmBtn variant="outline" aria-label="Settings">
          <trn-icon name="settings" motion="rotate" />
          Rotate
        </button>
      </div>`,
  }),
};
