import { type Meta, type StoryObj } from '@storybook/angular-vite';
import {
  MessageToolbarComponent,
  type MessageToolbarCaps,
} from './message-toolbar.component';

const ALL_ACTIONS: MessageToolbarCaps = {
  canEdit: true,
  canDelete: true,
  canPin: true,
  pinned: false,
  canThread: true,
  canQuote: true,
};

const meta: Meta<MessageToolbarComponent> = {
  title: 'Components/Message Toolbar',
  component: MessageToolbarComponent,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<MessageToolbarComponent>;

/** The floating surface and its complete inline action set. */
export const AllActions: Story = {
  args: { caps: ALL_ACTIONS },
};

/** Compact changes desktop chrome while the coarse-pointer floor remains global. */
export const Compact: Story = {
  args: { caps: ALL_ACTIONS },
  globals: { density: 'compact' },
};
