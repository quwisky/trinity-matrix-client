import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { HlmButton } from '@trinity/helm/button';
import { TrnSpinnerComponent } from '../spinner/trn-spinner.component';
import { EmptyStateComponent } from './empty-state.component';

/**
 * The stories are the argument for the component existing: fourteen surfaces had written this
 * by hand and agreed on the idea while disagreeing on every number. Seeing the shapes side by
 * side — icon or none, heading or none, an action or not — is what says whether one panel can
 * carry all of them.
 *
 * The danger tone is here to be looked at in **dark mode with each palette**, because that is
 * where the token choice matters: `--destructive` used as a foreground is a near-black maroon,
 * and only the theme switcher shows it.
 */
const meta: Meta<EmptyStateComponent> = {
  title: 'Components/Empty state',
  component: EmptyStateComponent,
  decorators: [
    (story) => ({
      ...story(),
      moduleMetadata: { imports: [HlmButton, TrnSpinnerComponent] },
    }),
  ],
};

export default meta;
type Story = StoryObj<EmptyStateComponent>;

/** The full shape: something is missing, and here is the thing that would fix it. */
export const WithAction: Story = {
  args: {
    icon: 'message-square',
    title: 'No threads yet',
    body: 'Reply in a thread to keep a side conversation out of the room.',
  },
  render: (args) => ({
    props: args,
    template: `
      <trn-empty-state [icon]="icon" [title]="title" [body]="body">
        <button trnEmptyStateActions hlmBtn size="sm">Start a thread</button>
      </trn-empty-state>
    `,
  }),
};

/** The commonest shape by far: one quiet sentence, no heading, no icon. */
export const BodyOnly: Story = {
  args: { body: 'No pinned messages in this room.' },
};

/** A heading with no body — the search panel before anything has been typed. */
export const TitleOnly: Story = {
  args: { icon: 'search', title: 'Search this room' },
};

/**
 * A failure sitting where an absence usually does. `text-danger`, never `text-destructive` —
 * flip to dark here and the difference is the whole point.
 */
export const Danger: Story = {
  args: {
    // No icon: the real site (the channel sidebar's failed room load) is a bare line where
    // the empty line would otherwise be, and the registry has no general alert glyph.
    title: "Couldn't load rooms",
    body: 'Check your connection and try again.',
    tone: 'danger',
  },
  render: (args) => ({
    props: args,
    template: `
      <trn-empty-state [title]="title" [body]="body" [tone]="tone">
        <button trnEmptyStateActions hlmBtn size="sm" variant="outline">Retry</button>
      </trn-empty-state>
    `,
  }),
};

/**
 * Projected content in place of the body string — the case a string input cannot express, and
 * the reason the default slot wins over `body`.
 */
export const Loading: Story = {
  args: { title: 'Looking for rooms' },
  render: (args) => ({
    props: args,
    template: `
      <trn-empty-state [title]="title">
        <trn-spinner />
      </trn-empty-state>
    `,
  }),
};
