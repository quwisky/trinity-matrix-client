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
