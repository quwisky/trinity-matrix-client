import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnTabPanelComponent } from './trn-tab-panel.component';
import { TrnTabsComponent } from './trn-tabs.component';

/**
 * Tabs, with the ARIA pattern coming from the kit primitive underneath rather than from this
 * wrapper. Worth putting the keyboard on: arrow keys move between triggers and select as they
 * go, Home and End jump to the ends, and a disabled tab is stepped over rather than focused.
 *
 * `Line` is the variant the settings dialogs use — a row of underlined triggers reads as
 * section navigation, where the filled `Default` reads as a control.
 */
const meta: Meta<TrnTabsComponent> = {
  title: 'Components/Tabs',
  component: TrnTabsComponent,
  decorators: [
    (story) => ({
      ...story(),
      moduleMetadata: { imports: [TrnTabPanelComponent] },
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'One panel at a time, chosen by a row of triggers. Triggers are data (`tabs`), ' +
          'panels are projected `<trn-tab-panel>` elements matched by `value`.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnTabsComponent>;

const TABS = [
  { value: 'general', label: 'General' },
  { value: 'access', label: 'Access' },
  { value: 'members', label: 'Members' },
];

const body = `
  <trn-tab-panel value="general" class="p-4">
    <p>Name, topic and photo.</p>
  </trn-tab-panel>
  <trn-tab-panel value="access" class="p-4">
    <p>Who can join, and how much history they see.</p>
  </trn-tab-panel>
  <trn-tab-panel value="members" class="p-4">
    <p>Who is here, and who is banned.</p>
  </trn-tab-panel>
`;

export const Default: Story = {
  args: { tabs: TABS, variant: 'default' },
  render: (args) => ({
    props: args,
    template: `<trn-tabs tab="general" [tabs]="tabs" [variant]="variant">${body}</trn-tabs>`,
  }),
};

export const Line: Story = {
  args: { tabs: TABS, variant: 'line' },
  render: (args) => ({
    props: args,
    template: `<trn-tabs tab="general" [tabs]="tabs" [variant]="variant">${body}</trn-tabs>`,
  }),
};

/** A tab can be turned off without leaving the row — the arrow keys step over it. */
export const WithDisabledTab: Story = {
  args: {
    tabs: [
      { value: 'general', label: 'General' },
      { value: 'access', label: 'Access', disabled: true },
      { value: 'members', label: 'Members' },
    ],
    variant: 'line',
  },
  render: (args) => ({
    props: args,
    template: `<trn-tabs tab="general" [tabs]="tabs" [variant]="variant">${body}</trn-tabs>`,
  }),
};

/** Vertical puts the triggers down the side; the arrow keys follow the layout. */
export const Vertical: Story = {
  args: { tabs: TABS, variant: 'line' },
  render: (args) => ({
    props: args,
    template: `<trn-tabs tab="general" orientation="vertical" [tabs]="tabs" [variant]="variant">${body}</trn-tabs>`,
  }),
};
