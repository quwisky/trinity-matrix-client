import {
  moduleMetadata,
  type Meta,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  TrnButton,
  TrnInput,
  TrnRadioGroupComponent,
  TrnSelectComponent,
  type TrnRadioOption,
  type TrnSelectOption,
} from '@trinity/components/controls';
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

const MEMBER_FILTERS: readonly TrnRadioOption<string>[] = [
  { value: 'joined', label: 'Joined' },
  { value: 'invited', label: 'Invited' },
];
const MEMBER_ORDERS: readonly TrnSelectOption<string>[] = [
  { value: 'name', label: 'Name' },
  { value: 'activity', label: 'Activity' },
];

/**
 * Form controls on the accent header. Each sits on the attention surface, so the field's
 * value, placeholder and resting border, the segmented track and the select trigger use the
 * attention control roles rather than colours tuned for a neutral surface. The toolbar
 * layout paints the accent too; pass `layout:toolbar`. The controls wrap in the page layout
 * on a phone; the toolbar layout is a fixed-height bar with room for them only on wider screens.
 */
export const AccentControls: Story = {
  args: { title: 'Members', variant: 'accent', layout: 'page' },
  decorators: [
    moduleMetadata({
      imports: [TrnInput, TrnRadioGroupComponent, TrnSelectComponent],
    }),
  ],
  render: (args) => ({
    props: {
      ...args,
      filters: MEMBER_FILTERS,
      filter: 'joined',
      orders: MEMBER_ORDERS,
      order: null,
    },
    template: `
      <trn-page-header [title]="title" [variant]="variant" [layout]="layout">
        <span trnHeaderActions class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <input trnInput size="sm" class="w-36" aria-label="Filter members" placeholder="Filter members" />
          <trn-radio-group
            layout="segmented"
            aria-label="Show"
            [options]="filters"
            [value]="filter"
            (valueChange)="filter = $event"
          />
          <span id="accent-header-order" class="sr-only">Sort by</span>
          <trn-select
            class="w-32"
            size="sm"
            aria-labelledby="accent-header-order"
            placeholder="Sort by"
            [options]="orders"
            [value]="order"
            (valueChange)="order = $event"
          />
        </span>
      </trn-page-header>`,
  }),
};
