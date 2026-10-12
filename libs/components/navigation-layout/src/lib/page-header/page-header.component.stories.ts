import {
  moduleMetadata,
  type Meta,
  type StoryObj,
} from '@storybook/angular-vite';
import { TrnButton } from '@trinity/components/controls';
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

/**
 * A solid action on the accent header. The header marks itself as an attention surface, so
 * the action inverts to the on-attention roles instead of an accent fill that would vanish
 * on the accent ground. The toolbar layout paints the accent too; pass `layout:toolbar`.
 */
export const AccentAction: Story = {
  args: { title: 'Security attention', variant: 'accent', layout: 'page' },
  decorators: [moduleMetadata({ imports: [TrnButton] })],
  render: (args) => ({
    props: args,
    template: `
      <trn-page-header [title]="title" [variant]="variant" [layout]="layout">
        <span trnHeaderActions>
          <button trnBtn size="sm">Verify</button>
        </span>
      </trn-page-header>`,
  }),
};
