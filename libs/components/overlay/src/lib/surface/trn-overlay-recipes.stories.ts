import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { provideTrnOverlayDefaults } from '../provide-overlay-defaults';
import { DialogOverlayStoryComponent } from './stories/dialog-overlay-story/dialog-overlay-story.component';
import { DropdownOverlayStoryComponent } from './stories/dropdown-overlay-story/dropdown-overlay-story.component';
import { FeedbackOverlayStoryComponent } from './stories/feedback-overlay-story/feedback-overlay-story.component';
import { LayeredOverlayStoryComponent } from './stories/layered-overlay-story/layered-overlay-story.component';

const meta: Meta = {
  title: 'Components/Overlay recipes',
  decorators: [
    applicationConfig({ providers: [provideTrnOverlayDefaults()] }),
    moduleMetadata({
      imports: [
        DialogOverlayStoryComponent,
        DropdownOverlayStoryComponent,
        FeedbackOverlayStoryComponent,
        LayeredOverlayStoryComponent,
      ],
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Trinity-owned overlay treatment, placement, lifecycle, and temporary compatibility forms across document and portal surfaces.',
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const LayeredSurfaces: Story = {
  render: () => ({ template: '<trn-layered-overlay-story />' }),
};

export const DropdownCompatibility: Story = {
  render: () => ({ template: '<trn-dropdown-overlay-story />' }),
};

export const DialogCompatibility: Story = {
  render: () => ({ template: '<trn-dialog-overlay-story />' }),
};

export const FeedbackCompatibility: Story = {
  render: () => ({ template: '<trn-feedback-overlay-story />' }),
};
