import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { PageHeaderComponent } from './page-header.component';

const meta: Meta<PageHeaderComponent> = {
  title: 'Components/Page Header',
  component: PageHeaderComponent,
  parameters: {
    docs: {
      description: {
        component:
          'One native page header and h1. Semantic treatment is independent from page or toolbar layout.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<PageHeaderComponent>;

export const Page: Story = {
  args: { title: 'Settings', variant: 'neutral', layout: 'page' },
};

export const Toolbar: Story = {
  args: { title: '# general', variant: 'neutral', layout: 'toolbar' },
};

export const Accent: Story = {
  args: { title: 'Security attention', variant: 'accent', layout: 'page' },
};

/** Temporary legacy layout variants beside their canonical equivalents. */
export const CompatibilityAliases: Story = {
  render: () => ({
    template: `
      <div class="grid gap-4">
        <trn-page-header data-testid="header-canonical-page" title="Canonical page" variant="neutral" layout="page" />
        <trn-page-header data-testid="header-legacy-page" title="Legacy page" variant="page" />
        <trn-page-header data-testid="header-canonical-toolbar" title="Canonical toolbar" variant="neutral" layout="toolbar" />
        <trn-page-header data-testid="header-legacy-toolbar" title="Legacy toolbar" variant="chat" />
      </div>
    `,
  }),
};
