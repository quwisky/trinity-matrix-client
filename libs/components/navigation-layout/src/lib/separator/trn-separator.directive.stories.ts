import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnSeparatorDirective } from './trn-separator.directive';

/**
 * A rule, and one decision: whether it means anything.
 *
 * The two stories below are pixel-identical and differ only in what a screen reader is told,
 * which is the whole point of having both. Open the a11y panel: `Announced` is a real
 * `separator` in the accessibility tree, `Decorative` has `role="none"` and is not there at
 * all. Decoration is the default, as upstream has it — a caller who wants the rule heard asks
 * for it, rather than every visual line quietly becoming a landmark.
 *
 * A directive rather than an element, because the thing it separates is usually a flex or
 * grid child and an extra wrapper would land in that layout.
 */
const meta: Meta<TrnSeparatorDirective> = {
  title: 'Components/Separator',
  component: TrnSeparatorDirective,
  parameters: {
    docs: {
      description: {
        component:
          'A horizontal or vertical rule. `decorative` (default true) decides whether it ' +
          'is announced as a separator or hidden from the accessibility tree.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnSeparatorDirective>;

/** Between two blocks of content, where the rule is doing a job. */
export const Horizontal: Story = {
  render: () => ({
    template: `
      <div class="w-80">
        <p class="text-sm">Everyone in this room can read the history.</p>
        <div trnSeparator class="my-3"></div>
        <p class="text-sm">Only members can send messages.</p>
      </div>`,
  }),
};

/** Between groups of controls — the toolbar case, and why vertical exists. */
export const Vertical: Story = {
  render: () => ({
    template: `
      <div class="flex h-8 items-center gap-2 text-sm">
        <span>Bold</span>
        <div trnSeparator orientation="vertical" [decorative]="false"></div>
        <span>Code</span>
        <div trnSeparator orientation="vertical" [decorative]="false"></div>
        <span>Link</span>
      </div>`,
  }),
};

/**
 * Structure: the rule stands for a break a sighted reader gets for free, so it is announced.
 * Identical on screen to {@link Decorative} below — the difference is in the a11y panel.
 */
export const Announced: Story = {
  render: () => ({
    template: `<div trnSeparator [decorative]="false" class="w-80"></div>`,
  }),
};

/** The default: a line drawn because it looks right, and silent because that is all it is. */
export const Decorative: Story = {
  render: () => ({
    template: `<div trnSeparator class="w-80"></div>`,
  }),
};
