import { type Meta, type StoryObj } from '@storybook/angular-vite';
import {
  MediaBubbleComponent,
  type MediaBubbleItem,
} from './media-bubble.component';

const FILE: MediaBubbleItem = {
  kind: 'file',
  filename: 'modern-interface-review.pdf',
  mimeType: 'application/pdf',
  size: 1_572_864,
};

const meta: Meta<MediaBubbleComponent> = {
  title: 'Components/Media Bubble',
  component: MediaBubbleComponent,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<MediaBubbleComponent>;

/** Raised file surface with control and metadata typography roles. */
export const File: Story = {
  args: { item: FILE },
};

/** The same file surface under root-level compact density. */
export const CompactFile: Story = {
  args: { item: FILE },
  globals: { density: 'compact' },
};

/** Error treatment stays actionable without becoming a saturated alert block. */
export const Error: Story = {
  args: { item: FILE, error: true },
};
