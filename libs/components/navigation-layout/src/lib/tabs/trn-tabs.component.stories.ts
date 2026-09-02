import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnTabPanelComponent } from './trn-tab-panel.component';
import { TrnTabsComponent } from './trn-tabs.component';

/**
 * Tabs, with the ARIA pattern coming from the kit primitive underneath rather than from this
 * wrapper. Worth putting the keyboard on: arrow keys move between triggers and select as they
 * go, Home and End jump to the ends, and a disabled tab is stepped over rather than focused.
 *
 * Line presentation reads as section navigation, while pills read as a control. Neutral and
 * accent treatment stay independent from that structural choice.
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

// The padding goes on the projected content, not on `<trn-tab-panel>`: the panel host is
// `display: contents` and generates no box, so a class there is silently dropped.
const body = `
  <trn-tab-panel value="general">
    <p class="p-4">Name, topic and photo.</p>
  </trn-tab-panel>
  <trn-tab-panel value="access">
    <p class="p-4">Who can join, and how much history they see.</p>
  </trn-tab-panel>
  <trn-tab-panel value="members">
    <p class="p-4">Who is here, and who is banned.</p>
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

export const NeutralPill: Story = {
  args: { tabs: TABS, variant: 'neutral', presentation: 'pill' },
  render: (args) => ({
    props: args,
    template: `<trn-tabs tab="general" [tabs]="tabs" [variant]="variant" [presentation]="presentation">${body}</trn-tabs>`,
  }),
};

export const AccentLine: Story = {
  args: { tabs: TABS, variant: 'accent', presentation: 'line' },
  render: (args) => ({
    props: args,
    template: `<trn-tabs tab="general" [tabs]="tabs" [variant]="variant" [presentation]="presentation">${body}</trn-tabs>`,
  }),
};

/** Legacy variants beside the canonical recipes they normalize to. */
export const CompatibilityAliases: Story = {
  render: () => ({
    props: { tabs: TABS },
    template: `
      <div class="grid gap-5">
        <trn-tabs data-testid="tabs-canonical-pill" tab="general" [tabs]="tabs" variant="neutral" presentation="pill">${body}</trn-tabs>
        <trn-tabs data-testid="tabs-legacy-pill" tab="general" [tabs]="tabs" variant="default">${body}</trn-tabs>
        <trn-tabs data-testid="tabs-canonical-line" tab="general" [tabs]="tabs" variant="neutral" presentation="line">${body}</trn-tabs>
        <trn-tabs data-testid="tabs-legacy-line" tab="general" [tabs]="tabs" variant="line">${body}</trn-tabs>
      </div>`,
  }),
};

/** Arrow keys move focus; Enter or Space commits the focused tab. */
export const ManualActivation: Story = {
  render: () => ({
    props: { tabs: TABS },
    template: `<trn-tabs tab="general" [tabs]="tabs" activationMode="manual">${body}</trn-tabs>`,
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
