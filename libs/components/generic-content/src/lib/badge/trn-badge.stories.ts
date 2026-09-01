import {
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { TrnBadge } from './trn-badge';

const meta: Meta<TrnBadge> = {
  title: 'Components/Badge',
  component: TrnBadge,
  decorators: [moduleMetadata({ imports: [TrnBadge] })],
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<TrnBadge>;

/** Status variants and compact geometry are intentionally narrower than the global registry. */
export const CanonicalRecipes: Story = {
  render: () => ({
    template: `
      <div class="grid gap-4 p-4">
        <div class="flex items-center gap-3">
          <span data-testid="badge-neutral" trnBadge variant="neutral">Neutral</span>
          <span data-testid="badge-success" trnBadge variant="success">Verified</span>
          <span data-testid="badge-warning" trnBadge variant="warning">Unverified</span>
        </div>
        <div class="flex items-center gap-3">
          <span data-testid="badge-xs" trnBadge variant="neutral" size="xs">Extra small</span>
          <span data-testid="badge-sm" trnBadge variant="neutral" size="sm">Small</span>
          <span data-testid="badge-md" trnBadge variant="neutral" size="md">Medium</span>
        </div>
      </div>
    `,
  }),
};

/** The former vendor-shaped name resolves to the canonical neutral status. */
export const CompatibilityDefault: Story = {
  render: () => ({
    template: `
      <div class="flex items-center gap-3 p-4">
        <span data-testid="badge-canonical-neutral" trnBadge variant="neutral">Neutral</span>
        <span data-testid="badge-legacy-default" trnBadge variant="default">Default</span>
      </div>
    `,
  }),
};
