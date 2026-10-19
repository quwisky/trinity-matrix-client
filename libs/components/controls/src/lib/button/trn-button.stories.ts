import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  provideTrnIcons,
  TrnIconComponent,
} from '@trinity/components/foundations';
import { TrnButton } from './trn-button';

const meta: Meta<TrnButton> = {
  title: 'Components/Button',
  component: TrnButton,
  decorators: [
    applicationConfig({ providers: [provideTrnIcons()] }),
    moduleMetadata({ imports: [TrnButton, TrnIconComponent] }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Trinity-owned semantic variants and ordinal sizes. Presentation and icon ' +
          'geometry are separate axes.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnButton>;

/** Canonical recipes across semantic treatment, presentation, state, and geometry. */
export const CanonicalStates: Story = {
  render: () => ({
    template: `
      <div class="grid gap-4 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <button data-testid="canonical-loading" type="button" trnBtn loading disabled>
            Saving…
          </button>
          <button data-testid="canonical-primary" type="button" trnBtn variant="primary" size="md">
            Continue
          </button>
        </div>
        <div
          data-testid="danger-card-surface"
          class="flex flex-wrap items-center gap-3 p-3"
          style="background: var(--trinity-surface-card)"
        >
          <button
            data-testid="danger-ghost-card"
            type="button"
            trnBtn
            variant="danger"
            presentation="ghost"
          >
            Remove from card
          </button>
        </div>
        <div
          data-testid="danger-rail-surface"
          class="flex flex-wrap items-center gap-3 p-3"
          style="background: var(--trinity-rail)"
        >
          <button
            data-testid="danger-ghost-rail"
            type="button"
            trnBtn
            variant="danger"
            presentation="ghost"
          >
            Remove from rail
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button data-testid="canonical-danger" type="button" trnBtn variant="danger" size="md">
            Remove
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button
            data-testid="canonical-primary-ghost"
            type="button"
            trnBtn
            variant="primary"
            presentation="ghost"
          >
            Primary quiet
          </button>
          <button
            data-testid="canonical-secondary-ghost"
            type="button"
            trnBtn
            variant="secondary"
            presentation="ghost"
          >
            Secondary quiet
          </button>
          <button
            data-testid="canonical-danger-ghost"
            type="button"
            trnBtn
            variant="danger"
            presentation="ghost"
          >
            Danger quiet
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button
            data-testid="canonical-icon"
            type="button"
            trnBtn
            variant="primary"
            presentation="ghost"
            shape="icon"
            size="md"
            aria-label="Canonical search"
          >
            <trn-icon name="search" motion="pop" />
          </button>
        </div>
      </div>
    `,
  }),
};

/** A solid primary action on the page canvas, a card and the rail, for focus-ring checks. */
export const SolidPrimaryFocus: Story = {
  render: () => ({
    template: `
      <div class="grid gap-4 p-4">
        <div data-testid="focus-surface-canvas" class="flex items-center gap-3 p-4">
          <button data-testid="focus-primary-canvas" type="button" trnBtn variant="primary" size="md">
            Unlock
          </button>
        </div>
        <div
          data-testid="focus-surface-card"
          class="flex items-center gap-3 p-4"
          style="background: var(--trinity-surface-card)"
        >
          <button data-testid="focus-primary-card" type="button" trnBtn variant="primary" size="md">
            Save changes
          </button>
        </div>
        <div
          data-testid="focus-surface-rail"
          class="flex items-center gap-3 p-4"
          style="background: var(--trinity-rail)"
        >
          <button
            data-testid="focus-primary-rail"
            type="button"
            trnBtn
            variant="primary"
            shape="icon"
            size="md"
            aria-label="Search rooms"
          >
            <trn-icon name="search" motion="pop" />
          </button>
        </div>
      </div>
    `,
  }),
};

/** Quick-action tiles: the icon square carries the fill and the label sits below it. */
export const Tiles: Story = {
  render: () => ({
    template: `
      <div class="flex justify-center gap-2 p-4">
        <button data-testid="tile-primary" type="button" trnBtn shape="tile">
          <trn-icon name="message-square" />
          Message
        </button>
        <button data-testid="tile-secondary" type="button" trnBtn variant="secondary" shape="tile">
          <trn-icon name="copy" />
          Copy ID
        </button>
        <button data-testid="tile-disabled" type="button" trnBtn shape="tile" disabled>
          <trn-icon name="shield-check" />
          Verify
        </button>
      </div>
    `,
  }),
};
