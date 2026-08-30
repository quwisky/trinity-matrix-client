import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnSeparatorDirective } from '@trinity/components/navigation-layout';
import { TrnToggleGroupComponent } from './trn-toggle-group.component';
import { TrnToggleGroupItemDirective } from './trn-toggle-group-item.directive';

/**
 * The states worth looking at here are mostly things you cannot see in a screenshot.
 *
 * Selection and orientation are visible. The rest of what this wrapper adds — one tab stop
 * for the whole bar, arrows that move along the orientation, Home/End, a disabled button that
 * is stepped over rather than focused — only shows up if you put the keyboard on it, which is
 * exactly why the stories exist rather than a screenshot: **Tab into each one, then arrow
 * through it.** A bar that takes nine Tab presses to cross is the failure being guarded
 * against, and it looks identical to a correct one.
 *
 * The a11y addon is worth a glance on `Vertical` in particular: `aria-orientation` and the
 * layout are driven from the same input, and this is where they used to disagree.
 */
const meta: Meta<TrnToggleGroupComponent> = {
  title: 'Components/Toggle group',
  component: TrnToggleGroupComponent,
  decorators: [
    (story) => ({
      ...story(),
      moduleMetadata: {
        imports: [
          TrnToggleGroupItemDirective,
          TrnSeparatorDirective,
          TrnIconComponent,
        ],
      },
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'A group of toggle buttons with toolbar keyboard behaviour: one tab stop, arrow ' +
          'keys along its orientation, Home/End to the ends, and disabled items skipped. ' +
          'Selection is the kit primitive underneath; the keyboard is this wrapper.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TrnToggleGroupComponent>;

/**
 * The shape phase 5 is heading for: nine formatting actions in three groups, divided by
 * rules. Separators are `[decorative]="false"` here because a rule between two groups of
 * buttons is structure a screen reader should hear, not a line drawn for looks.
 */
export const FormattingBar: Story = {
  render: () => ({
    template: `
      <trn-toggle-group type="multiple" aria-label="Formatting">
        <button trnToggleGroupItem value="bold" aria-label="Bold">
          <trn-icon name="bold" />
        </button>
        <button trnToggleGroupItem value="italic" aria-label="Italic">
          <trn-icon name="italic" />
        </button>
        <button trnToggleGroupItem value="strikethrough" aria-label="Strikethrough">
          <trn-icon name="strikethrough" />
        </button>

        <div trnSeparator orientation="vertical" [decorative]="false"></div>

        <button trnToggleGroupItem value="code" aria-label="Code">
          <trn-icon name="code" />
        </button>
        <button trnToggleGroupItem value="quote" aria-label="Quote">
          <trn-icon name="quote" />
        </button>

        <div trnSeparator orientation="vertical" [decorative]="false"></div>

        <button trnToggleGroupItem value="link" aria-label="Link">
          <trn-icon name="link" />
        </button>
        <button trnToggleGroupItem value="list" aria-label="List">
          <trn-icon name="list" />
        </button>
      </trn-toggle-group>`,
  }),
};

/**
 * One at a time — a view switcher rather than a formatting bar. `type="single"` is the kit's
 * input, published onto this host, which is the thing that made the wrapper worth testing:
 * it reaches `BrnToggleGroup` through two layers of `hostDirectives`.
 */
export const SingleSelection: Story = {
  render: () => ({
    template: `
      <trn-toggle-group type="single" value="all" aria-label="Filter">
        <button trnToggleGroupItem value="all">All</button>
        <button trnToggleGroupItem value="unread">Unread</button>
        <button trnToggleGroupItem value="mentions">Mentions</button>
      </trn-toggle-group>`,
  }),
};

/**
 * Up and Down move here, not Left and Right. The layout follows the same input, so a bar that
 * announces itself as vertical is also drawn as one — worth checking together, because they
 * are two different consumers of one signal.
 */
export const Vertical: Story = {
  render: () => ({
    template: `
      <trn-toggle-group
        type="single"
        orientation="vertical"
        value="list"
        aria-label="Layout"
      >
        <button trnToggleGroupItem value="list">List</button>
        <button trnToggleGroupItem value="grid">Grid</button>
        <button trnToggleGroupItem value="compact">Compact</button>
      </trn-toggle-group>`,
  }),
};

/**
 * Arrow past the disabled button and focus lands on the one after it.
 *
 * The alternative — focusing a control that cannot be pressed — is the worse failure: the
 * keyboard user arrives somewhere, presses it, and nothing happens with no explanation. It
 * also matters for the tab stop: if the FIRST button is the disabled one, the stop has to go
 * to another, or the whole bar drops out of the tab order.
 */
export const WithADisabledItem: Story = {
  render: () => ({
    template: `
      <trn-toggle-group type="multiple" aria-label="Formatting">
        <button trnToggleGroupItem value="bold" aria-label="Bold">
          <trn-icon name="bold" />
        </button>
        <button trnToggleGroupItem value="italic" aria-label="Italic" disabled>
          <trn-icon name="italic" />
        </button>
        <button trnToggleGroupItem value="code" aria-label="Code">
          <trn-icon name="code" />
        </button>
      </trn-toggle-group>`,
  }),
};

/** The whole bar off — the kit's group-level `disabled`, not each button's. */
export const WholeGroupDisabled: Story = {
  render: () => ({
    template: `
      <trn-toggle-group type="multiple" disabled aria-label="Formatting">
        <button trnToggleGroupItem value="bold" aria-label="Bold">
          <trn-icon name="bold" />
        </button>
        <button trnToggleGroupItem value="italic" aria-label="Italic">
          <trn-icon name="italic" />
        </button>
      </trn-toggle-group>`,
  }),
};

/** `variant` and `size` are the kit's, re-published unchanged. */
export const OutlineSmall: Story = {
  render: () => ({
    template: `
      <trn-toggle-group type="single" variant="outline" size="sm" value="day">
        <button trnToggleGroupItem value="day">Day</button>
        <button trnToggleGroupItem value="week">Week</button>
        <button trnToggleGroupItem value="month">Month</button>
      </trn-toggle-group>`,
  }),
};
