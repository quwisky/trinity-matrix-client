import {
  moduleMetadata,
  type Meta,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  TrnButton,
  TrnCheckboxComponent,
  TrnInput,
  TrnRadioGroupComponent,
  TrnSelectComponent,
  TrnSwitchComponent,
  TrnTextarea,
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

/**
 * A checkbox, a switch, a file input and an outline button on the accent header. The
 * resting checkbox border and switch track use the attention control border, and once
 * checked both invert like a solid action. The file input's button label takes the attention
 * foreground, and the outline button stays transparent with the attention border and label.
 * Both layouts paint the accent; pass `layout:toolbar`. The toolbar layout is a fixed 48px
 * bar with room for these only on wider screens.
 */
export const AccentChoiceControls: Story = {
  args: { title: 'Members', variant: 'accent', layout: 'page' },
  decorators: [
    moduleMetadata({
      imports: [TrnButton, TrnCheckboxComponent, TrnInput, TrnSwitchComponent],
    }),
  ],
  render: (args) => ({
    props: { ...args, adminsOnly: false, live: false },
    template: `
      <trn-page-header [title]="title" [variant]="variant" [layout]="layout">
        <span trnHeaderActions class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <label class="flex items-center gap-1 text-sm">
            <trn-checkbox [checked]="adminsOnly" (checkedChange)="adminsOnly = $event" />
            Admins only
          </label>
          <label class="flex items-center gap-1 text-sm">
            <trn-switch [checked]="live" (checkedChange)="live = $event" />
            Live
          </label>
          <input trnInput type="file" size="sm" class="w-48" aria-label="Import members" />
          <button trnBtn presentation="outline" size="sm" type="button">Export</button>
        </span>
      </trn-page-header>`,
  }),
};

const MEMBER_ROLES: readonly TrnSelectOption<string>[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
];

/**
 * Invalid controls on the accent header. The danger border and its 2px ring take the
 * attention danger role, which keeps 3:1 against the accent; the ring is the cue that does
 * not rely on hue, and the error message inherits the header's foreground because the
 * neutral danger text falls near 1.4:1 there. Both layouts paint the accent; pass
 * `layout:toolbar`. The toolbar layout has room for these only on wider screens.
 */
export const AccentFieldStates: Story = {
  args: { title: 'Invite', variant: 'accent', layout: 'page' },
  decorators: [
    moduleMetadata({
      imports: [TrnCheckboxComponent, TrnInput, TrnSelectComponent],
    }),
  ],
  render: (args) => ({
    props: { ...args, roles: MEMBER_ROLES, role: null },
    template: `
      <trn-page-header [title]="title" [variant]="variant" [layout]="layout">
        <span trnHeaderActions class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <input
            trnInput
            explicitInvalid
            size="sm"
            class="w-36"
            aria-label="Invitee"
            aria-describedby="accent-header-invitee-error"
            value="@alice"
          />
          <span id="accent-header-invitee-error" class="text-sm">Use a full ID</span>
          <span id="accent-header-role" class="sr-only">Role</span>
          <trn-select
            class="w-32"
            size="sm"
            invalid
            aria-labelledby="accent-header-role"
            placeholder="Choose a role"
            [options]="roles"
            [value]="role"
            (valueChange)="role = $event"
          />
          <label class="flex items-center gap-1 text-sm">
            <trn-checkbox invalid />
            I agree
          </label>
        </span>
      </trn-page-header>`,
  }),
};

const NOTIFY_LEVELS: readonly TrnRadioOption<string>[] = [
  { value: 'all', label: 'All messages', description: 'Every new message' },
  { value: 'mentions', label: 'Mentions', description: 'Only when named' },
];
const HISTORY_SCOPES: readonly TrnRadioOption<string>[] = [
  { value: 'members', label: 'Members', description: 'Since they joined' },
  { value: 'anyone', label: 'Anyone', description: 'All history' },
];

/**
 * Controls that stack more than one line on the accent header: a list radio group, a
 * segmented group with option descriptions and an invalid textarea. The radio ring, the
 * checked dot, the labels and the descriptions use the attention control roles. Only the page
 * layout grows to fit them; the toolbar layout is a fixed 48px bar.
 */
export const AccentStackedControls: Story = {
  args: { title: 'Room defaults', variant: 'accent', layout: 'page' },
  decorators: [
    moduleMetadata({
      imports: [TrnRadioGroupComponent, TrnTextarea],
    }),
  ],
  render: (args) => ({
    props: {
      ...args,
      levels: NOTIFY_LEVELS,
      level: 'all',
      scopes: HISTORY_SCOPES,
      scope: 'members',
    },
    template: `
      <trn-page-header [title]="title" [variant]="variant" [layout]="layout">
        <span trnHeaderActions class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-4 py-2">
          <trn-radio-group
            aria-label="Notify me"
            [options]="levels"
            [value]="level"
            (valueChange)="level = $event"
          />
          <trn-radio-group
            layout="segmented"
            aria-label="History visible to"
            [options]="scopes"
            [value]="scope"
            (valueChange)="scope = $event"
          />
          <span class="grid gap-1">
            <textarea
              trnTextarea
              explicitInvalid
              size="sm"
              class="w-56"
              aria-label="Room topic"
              aria-describedby="accent-header-topic-error"
            ></textarea>
            <span id="accent-header-topic-error" class="text-sm">Add a topic</span>
          </span>
        </span>
      </trn-page-header>`,
  }),
};
