import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { provideTrnIcons } from '../trn-icon.icons';
import { TrnIconComponent } from './trn-icon.component';

const meta: Meta<TrnIconComponent> = {
  title: 'Components/Icon',
  component: TrnIconComponent,
  decorators: [
    applicationConfig({ providers: [provideTrnIcons()] }),
    moduleMetadata({ imports: [TrnIconComponent] }),
  ],
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<TrnIconComponent>;

/** The complete ordinal geometry, independent of the surrounding text size. */
export const CanonicalSizes: Story = {
  render: () => ({
    template: `
      <div class="p-4">
        <span class="mr-4 inline-block"><trn-icon data-testid="icon-2xs" name="star" size="2xs" label="Extra extra small" /></span>
        <span class="mr-4 inline-block"><trn-icon data-testid="icon-xs" name="star" size="xs" label="Extra small" /></span>
        <span class="mr-4 inline-block"><trn-icon data-testid="icon-sm" name="star" size="sm" label="Small" /></span>
        <span class="mr-4 inline-block"><trn-icon data-testid="icon-md" name="star" size="md" label="Medium" /></span>
        <span class="mr-4 inline-block"><trn-icon data-testid="icon-lg" name="star" size="lg" label="Large" /></span>
        <span class="mr-4 inline-block"><trn-icon data-testid="icon-xl" name="star" size="xl" label="Extra large" /></span>
        <span class="inline-block"><trn-icon data-testid="icon-2xl" name="star" size="2xl" label="Extra extra large" /></span>
      </div>
    `,
  }),
};

/** Semantic ink is optional because icons inside controls normally inherit their colour. */
export const SemanticVariants: Story = {
  render: () => ({
    template: `
      <div class="flex gap-4 p-4">
        <trn-icon data-testid="icon-neutral" name="shield" size="lg" variant="neutral" label="Neutral" />
        <trn-icon data-testid="icon-accent" name="shield" size="lg" variant="accent" label="Accent" />
        <trn-icon data-testid="icon-muted" name="shield" size="lg" variant="muted" label="Muted" />
        <trn-icon data-testid="icon-danger" name="shield-alert" size="lg" variant="danger" label="Danger" />
      </div>
    `,
  }),
};

/** Exact CSS lengths remain valid until the existing templates finish migrating. */
export const CompatibilityLength: Story = {
  render: () => ({
    template: `
      <div class="flex items-center gap-4 p-4">
        <trn-icon data-testid="icon-canonical-lg" name="search" size="lg" label="Canonical large" />
        <trn-icon data-testid="icon-legacy-lg" name="search" size="1.25rem" label="Legacy large" />
      </div>
    `,
  }),
};
