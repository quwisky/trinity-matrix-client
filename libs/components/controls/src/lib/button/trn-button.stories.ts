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
          'geometry are separate axes; Helm-shaped inputs remain temporary compatibility aliases.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnButton>;

/** Canonical recipes beside their temporary compatibility equivalents. */
export const CanonicalAndCompatibility: Story = {
  render: () => ({
    template: `
      <div class="grid gap-4 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <button data-testid="canonical-primary" type="button" trnBtn variant="primary" size="md">
            Continue
          </button>
          <button data-testid="legacy-primary" type="button" trnBtn variant="default" size="default">
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
          <button data-testid="legacy-danger" type="button" trnBtn variant="destructive" size="default">
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
          <button
            data-testid="legacy-icon"
            type="button"
            trnBtn
            variant="ghost"
            size="icon"
            aria-label="Compatibility search"
          >
            <trn-icon name="search" motion="pop" />
          </button>
        </div>
      </div>
    `,
  }),
};
