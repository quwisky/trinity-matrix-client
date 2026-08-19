import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnProgressComponent } from './trn-progress.component';

/**
 * One story per STATE, not per component.
 *
 * The determinate/indeterminate split is the whole of this component's behaviour and it is
 * invisible in a screenshot of the default: an indeterminate bar has no `aria-valuenow` and
 * animates, a determinate one reports its value and does not. Flip the palette and mode in the
 * toolbar to see both against every ground the app can put them on.
 */
const meta: Meta<TrnProgressComponent> = {
  title: 'Components/Progress',
  component: TrnProgressComponent,
  parameters: {
    docs: {
      description: {
        component:
          'A thin determinate/indeterminate bar. `value` is a percentage; `null` means ' +
          'indeterminate — work is happening but its size is not yet known.',
      },
    },
  },
  argTypes: {
    value: {
      control: { type: 'range', min: 0, max: 100, step: 1 },
      description: '0–100, or null for indeterminate',
    },
  },
};

export default meta;

/**
 * `aria-label` is an ALIASED input (`input(null, { alias: 'aria-label' })`), and the two halves
 * of Storybook disagree about which name to use: the renderer sets inputs by the ALIAS, while
 * `StoryObj`'s generated arg type only knows the property name. Following the type compiles and
 * silently renders no accessible name at all — measured, not assumed: `ariaLabel` produces
 * `aria-label=null` in the DOM, `'aria-label'` produces the label.
 *
 * So the alias is what the args use, and the type is widened to admit it rather than the other
 * way round.
 */
type ProgressArgs = TrnProgressComponent & { 'aria-label': string | null };
type Story = StoryObj<ProgressArgs>;

export const Determinate: Story = {
  args: { value: 60, 'aria-label': 'Uploading holiday.png' },
};

export const Indeterminate: Story = {
  // The state the composer shows first: the metadata probe and thumbnail upload happen before
  // any fraction exists, and a bar pinned at 0% reads as stalled rather than as working.
  args: { value: null, 'aria-label': 'Uploading attachment' },
};

export const JustStarted: Story = {
  args: { value: 0, 'aria-label': 'Uploading holiday.png' },
};

export const Complete: Story = {
  args: { value: 100, 'aria-label': 'Uploaded holiday.png' },
};

export const InABatch: Story = {
  // How the composer labels it mid-batch. The label is the component's accessible name, so
  // this is also the check that it is announced rather than merely drawn.
  args: { value: 40, 'aria-label': 'Uploading holiday.png (2 of 5)' },
};
