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

const VIDEO: MediaBubbleItem = {
  kind: 'video',
  filename: 'standup-recording.mp4',
  mimeType: 'video/mp4',
  size: 18_874_368,
  width: 1280,
  height: 720,
  durationMs: 83_000,
};

const AUDIO: MediaBubbleItem = {
  kind: 'audio',
  filename: 'interview.mp3',
  mimeType: 'audio/mpeg',
  size: 3_145_728,
  durationMs: 214_000,
};

/** A video waits behind its play button with no thumbnail; nothing is fetched until it is pressed. */
export const VideoPlaceholder: Story = {
  args: { item: VIDEO },
};

/** The play button while the file is fetched: busy, named for the wait, and pressing it again does nothing. */
export const VideoLoading: Story = {
  args: { item: VIDEO, loading: true },
};

/** Audio shows its player row with the declared length before any bytes are loaded. */
export const AudioIdle: Story = {
  args: { item: AUDIO },
};

export const AudioLoading: Story = {
  args: { item: AUDIO, loading: true },
};
