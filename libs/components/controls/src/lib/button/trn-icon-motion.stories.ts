import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  provideTrnIcons,
  TrnIconComponent,
  type TrnIconMotion,
} from '@trinity/components/foundations';
import { TrnButton, TrnIconButton } from './trn-button';

const meta: Meta<TrnIconComponent> = {
  title: 'Components/Icon motion',
  component: TrnIconComponent,
  decorators: [
    applicationConfig({ providers: [provideTrnIcons()] }),
    moduleMetadata({ imports: [TrnButton, TrnIconButton, TrnIconComponent] }),
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
  icon:
    | 'arrow-left'
    | 'chevron-down'
    | 'chevron-up'
    | 'search'
    | 'send'
    | 'settings',
  label: string,
  disabled = false,
) => ({
  template: `
    <div class="flex items-center gap-3 p-4" data-testid="motion-row">
      <button
        type="button"
        trnBtn
        variant="ghost"
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

/** Directional controls move toward the destination they advertise. */
export const NudgeUp: Story = {
  render: () => motionButton('nudge-up', 'chevron-up', 'Move up'),
};

/** Directional controls move toward the destination they advertise. */
export const NudgeDown: Story = {
  render: () => motionButton('nudge-down', 'chevron-down', 'Move down'),
};

/** A send affordance moves along the paper-plane's direction of travel. */
export const NudgeUpRight: Story = {
  render: () => motionButton('nudge-up-right', 'send', 'Send'),
};

/** Discovery and reveal actions grow slightly without changing their hit area. */
export const Pop: Story = {
  render: () => motionButton('pop', 'search', 'Search'),
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
        <button type="button" trnBtn variant="ghost" size="icon" aria-label="Back">
          <trn-icon name="arrow-left" motion="nudge-left" />
        </button>
        <button type="button" trnBtn variant="ghost" size="icon" aria-label="Move up">
          <trn-icon name="chevron-up" motion="nudge-up" />
        </button>
        <button type="button" trnBtn variant="ghost" size="icon" aria-label="Move down">
          <trn-icon name="chevron-down" motion="nudge-down" />
        </button>
        <button type="button" trnBtn variant="ghost" size="icon" aria-label="Send">
          <trn-icon name="send" motion="nudge-up-right" />
        </button>
        <button type="button" trnBtn variant="ghost" size="icon" aria-label="Search">
          <trn-icon name="search" motion="pop" />
        </button>
        <button type="button" trnBtn variant="ghost" size="icon" aria-label="Settings">
          <trn-icon name="settings" motion="rotate" />
        </button>
      </div>`,
  }),
};

/** The public button keeps invariant interaction styling across size and contextual tone. */
export const Treatments: Story = {
  render: () => ({
    template: `
      <div class="flex flex-wrap items-center gap-3 p-4">
        <button type="button" trnBtn variant="ghost" size="icon-xs" aria-label="Small action">
          <trn-icon name="search" motion="pop" />
        </button>
        <button
          type="button"
          trnBtn
          variant="ghost"
          size="icon-sm"
          class="text-danger hover:text-danger"
          aria-label="Destructive action"
        >
          <trn-icon name="trash-2" motion="nudge-down" />
        </button>
        <button
          type="button"
          trnBtn
          variant="secondary"
          size="icon-lg"
          class="border border-border shadow-sm"
          aria-label="Floating action"
        >
          <trn-icon name="x" motion="rotate" />
        </button>
        <button
          type="button"
          trnBtn
          variant="ghost"
          size="icon"
          aria-label="Unavailable action"
          disabled
        >
          <trn-icon name="settings" motion="rotate" />
        </button>
        <a trnBtn variant="ghost" size="icon" href="#target" aria-label="Linked action">
          <trn-icon name="arrow-left" motion="nudge-left" />
        </a>
        <button
          type="button"
          trnIconButton
          class="grid size-12 place-items-center rounded-full bg-secondary"
          aria-label="Purpose-built action"
        >
          <trn-icon name="camera" motion="pop" />
        </button>
      </div>`,
  }),
};
