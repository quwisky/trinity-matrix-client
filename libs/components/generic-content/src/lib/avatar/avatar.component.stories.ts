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
          <trn-avatar name="Alice" initial="A" shape="person" size="2xl" />
          <figcaption>Person fallback</figcaption>
        </figure>
        <figure style="display:grid;gap:8px;justify-items:center;margin:0">
          <trn-avatar name="Design room" initial="D" shape="place" size="2xl" />
          <figcaption>Place fallback</figcaption>
        </figure>
        <figure style="display:grid;gap:8px;justify-items:center;margin:0">
          <trn-avatar name="Alice" shape="person" [url]="sampleImage" size="2xl" />
          <figcaption>Person image</figcaption>
        </figure>
        <figure style="display:grid;gap:8px;justify-items:center;margin:0">
          <trn-avatar name="Design room" shape="place" [url]="sampleImage" size="2xl" />
          <figcaption>Place image</figcaption>
        </figure>
      </div>
    `,
  }),
};

/** Named sizes cover ordinary identity surfaces from metadata through profiles. */
export const CanonicalSizes: Story = {
  render: () => ({
    template: `
      <div class="flex items-end gap-4 p-4">
        <trn-avatar data-testid="avatar-2xs" name="Ada" initial="A" size="2xs" />
        <trn-avatar data-testid="avatar-xs" name="Ada" initial="A" size="xs" />
        <trn-avatar data-testid="avatar-sm" name="Ada" initial="A" size="sm" />
        <trn-avatar data-testid="avatar-md" name="Ada" initial="A" size="md" />
        <trn-avatar data-testid="avatar-lg" name="Ada" initial="A" size="lg" />
        <trn-avatar data-testid="avatar-xl" name="Ada" initial="A" size="xl" />
        <trn-avatar data-testid="avatar-2xl" name="Ada" initial="A" size="2xl" />
      </div>
    `,
  }),
};

/** Presence roles resolve through Theme Foundation rather than component-local colours. */
export const SemanticPresence: Story = {
  render: () => ({
    template: `
      <div class="flex gap-6 p-4">
        <trn-avatar data-testid="avatar-online" name="Online" initial="O" size="xl" presence="online" />
        <trn-avatar data-testid="avatar-away" name="Away" initial="A" size="xl" presence="unavailable" />
        <trn-avatar data-testid="avatar-offline" name="Offline" initial="F" size="xl" presence="offline" />
      </div>
    `,
  }),
};

/** Numeric size and the bounded exact escape remain valid while layouts migrate. */
export const CompatibilityGeometry: Story = {
  render: () => ({
    template: `
      <div class="flex items-center gap-4 p-4">
        <trn-avatar data-testid="avatar-canonical" name="Canonical" initial="C" size="2xl" />
        <trn-avatar data-testid="avatar-legacy" name="Legacy" initial="L" [size]="48" />
        <trn-avatar data-testid="avatar-exact" name="Exact" initial="E" size="sm" [exactSize]="48" />
      </div>
    `,
  }),
};
