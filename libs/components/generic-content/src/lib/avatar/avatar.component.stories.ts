import { type Meta, type StoryObj } from '@storybook/angular-vite';
import { AvatarComponent } from './avatar.component';

const SAMPLE_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%235865f2'/%3E%3Ccircle cx='50' cy='36' r='19' fill='white'/%3E%3Cpath d='M16 100c3-25 17-39 34-39s31 14 34 39' fill='white'/%3E%3C/svg%3E";

/**
 * The semantic geometry contract in one canvas. Use Storybook's Theme and Mode toolbar
 * controls to compare every combination; avatar geometry is deliberately density-invariant.
 */
const meta: Meta<AvatarComponent> = {
  title: 'Components/Avatar',
  component: AvatarComponent,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<AvatarComponent>;

/** People stay circular and places stay squircle-shaped, for images and fallbacks alike. */
export const SemanticShapes: Story = {
  render: () => ({
    props: { sampleImage: SAMPLE_IMAGE },
    template: `
      <div style="display:grid;grid-template-columns:repeat(2,auto);gap:24px 32px;text-align:center">
        <figure style="display:grid;gap:8px;justify-items:center;margin:0">
          <trn-avatar name="Alice" initial="A" shape="person" [size]="48" />
          <figcaption>Person fallback</figcaption>
        </figure>
        <figure style="display:grid;gap:8px;justify-items:center;margin:0">
          <trn-avatar name="Design room" initial="D" shape="place" [size]="48" />
          <figcaption>Place fallback</figcaption>
        </figure>
        <figure style="display:grid;gap:8px;justify-items:center;margin:0">
          <trn-avatar name="Alice" shape="person" [url]="sampleImage" [size]="48" />
          <figcaption>Person image</figcaption>
        </figure>
        <figure style="display:grid;gap:8px;justify-items:center;margin:0">
          <trn-avatar name="Design room" shape="place" [url]="sampleImage" [size]="48" />
          <figcaption>Place image</figcaption>
        </figure>
      </div>
    `,
  }),
};
