import {
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { TrnSpinnerComponent } from './trn-spinner.component';

const meta: Meta<TrnSpinnerComponent> = {
  title: 'Components/Spinner',
  component: TrnSpinnerComponent,
  decorators: [moduleMetadata({ imports: [TrnSpinnerComponent] })],
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<TrnSpinnerComponent>;

/** The spinner exposes only geometry and semantic ink; loading remains its behavior. */
export const CanonicalRecipes: Story = {
  render: () => ({
    template: `
      <div class="p-4">
        <span class="mr-5 inline-block"><trn-spinner data-testid="spinner-xs" size="xs" variant="neutral" aria-label="Extra small loading" /></span>
        <span class="mr-5 inline-block"><trn-spinner data-testid="spinner-sm" size="sm" variant="muted" aria-label="Small loading" /></span>
        <span class="mr-5 inline-block"><trn-spinner data-testid="spinner-md" size="md" variant="accent" aria-label="Medium loading" /></span>
        <span class="inline-block"><trn-spinner data-testid="spinner-lg" size="lg" variant="danger" aria-label="Large loading" /></span>
      </div>
    `,
  }),
};

/** Omitting variant retains the surrounding text colour, matching existing call sites. */
export const InheritedInk: Story = {
  render: () => ({
    template: `
      <div class="p-4 text-[var(--trinity-link)]">
        <trn-spinner data-testid="spinner-inherited" aria-label="Inherited loading" />
      </div>
    `,
  }),
};
