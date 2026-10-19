import {
  moduleMetadata,
  type Meta,
  type StoryObj,
} from '@storybook/angular-vite';
import { TrnTab } from './trn-tab';
import { TrnTabList } from './trn-tab-list';
import { TrnTabPanel } from './trn-tab-panel';
import {
  TrnTabs,
  type TrnTabsActivation,
  type TrnTabsAppearance,
} from './trn-tabs';

interface TabsStoryArgs {
  activation: TrnTabsActivation;
  appearance: TrnTabsAppearance;
  disabledTab: string | null;
  width: string;
}

const TABS = [
  { value: 'gif', label: 'GIFs' },
  { value: 'sticker', label: 'Stickers' },
  { value: 'emoji', label: 'Emoji' },
] as const;

const meta: Meta<TabsStoryArgs> = {
  title: 'Components/Tabs',
  decorators: [
    moduleMetadata({ imports: [TrnTabs, TrnTabList, TrnTab, TrnTabPanel] }),
  ],
  args: {
    activation: 'automatic',
    appearance: 'segmented',
    disabledTab: null,
    width: '18.875rem',
  },
  argTypes: {
    activation: { control: 'inline-radio', options: ['automatic', 'manual'] },
    appearance: {
      control: 'inline-radio',
      options: ['segmented', 'underline'],
    },
  },
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The WAI-ARIA tabs pattern. Arrow keys, Home and End move between tabs; with ' +
          'automatic activation (the default) moving also selects, with manual activation ' +
          'Enter, Space or a click selects. The caller names the list.',
      },
    },
  },
  render: (args) => ({
    props: { ...args, tabs: TABS, value: 'emoji' },
    template: `
      <div
        class="rounded-[var(--trinity-shape-control-radius)] bg-[var(--trinity-surface-overlay)] p-3"
        [style.width]="width"
      >
        <div trnTabs [activation]="activation" [appearance]="appearance" [(value)]="value">
          <div trnTabList aria-label="Picker type">
            @for (tab of tabs; track tab.value) {
              <button [trnTab]="tab.value" [disabled]="tab.value === disabledTab">
                {{ tab.label }}
              </button>
            }
          </div>
          @for (tab of tabs; track tab.value) {
            <div [trnTabPanel]="tab.value" class="p-3 text-sm text-[var(--trinity-text-bright)]">
              {{ tab.label }} panel
            </div>
          }
        </div>
      </div>
    `,
  }),
};

export default meta;
type Story = StoryObj<TabsStoryArgs>;

export const Default: Story = {};

/** For panels whose content takes focus when it appears, such as a search field. */
export const Manual: Story = { args: { activation: 'manual' } };

/** A disabled tab is skipped by the arrow keys and left out of the tab order. */
export const DisabledTab: Story = { args: { disabledTab: 'sticker' } };

/** On a coarse pointer every tab is at least 44px tall; open this on a touch device. */
export const CoarsePointer: Story = { args: { width: '22rem' } };

/** A divided strip with an accent bar under the selected tab, as on the member card. */
export const Underline: Story = { args: { appearance: 'underline' } };
