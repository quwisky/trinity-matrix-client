import {
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from './trn-tooltip';

const meta: Meta<TrnTooltip> = {
  title: 'Components/Tooltip',
  component: TrnTooltip,
  decorators: [moduleMetadata({ imports: [TrnButton, TrnTooltip] })],
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<TrnTooltip>;

/** Position is behavior; tooltip appearance stays on its one semantic surface contract. */
export const Positions: Story = {
  render: () => ({
    template: `
      <div class="grid grid-cols-2 gap-12 p-16">
        <button data-testid="tooltip-top" type="button" trnBtn variant="secondary" presentation="outline" trnTooltip="Above" position="top">Top</button>
        <button data-testid="tooltip-right" type="button" trnBtn variant="secondary" presentation="outline" trnTooltip="To the right" position="right">Right</button>
        <button data-testid="tooltip-bottom" type="button" trnBtn variant="secondary" presentation="outline" trnTooltip="Below" position="bottom">Bottom</button>
        <button data-testid="tooltip-left" type="button" trnBtn variant="secondary" presentation="outline" trnTooltip="To the left" position="left">Left</button>
      </div>
    `,
  }),
};

/** A touch tap must activate the next control even when it focuses this trigger. */
export const TouchAction: Story = {
  render: () => ({
    template: `
      <div class="flex flex-col items-center gap-4 p-16">
        <button data-testid="tooltip-touch-source" type="button" trnBtn trnTooltip="Source" position="bottom">Source</button>
        <a data-testid="tooltip-touch-target" href="#touch-target-activated" trnBtn>Target</a>
      </div>
    `,
  }),
};
