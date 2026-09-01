import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  provideTrnIcons,
  TrnIconComponent,
} from '@trinity/components/foundations';
import { AvatarComponent } from './avatar/avatar.component';
import { TrnBadge } from './badge/trn-badge';
import { BannerComponent } from './banner/banner.component';
import { EmptyStateComponent } from './empty-state/empty-state.component';
import { TrnProgressComponent } from './progress/trn-progress.component';
import { TrnSpinnerComponent } from './spinner/trn-spinner.component';

const meta: Meta = {
  title: 'Components/Content recipe matrix',
  decorators: [
    applicationConfig({ providers: [provideTrnIcons()] }),
    moduleMetadata({
      imports: [
        AvatarComponent,
        BannerComponent,
        EmptyStateComponent,
        TrnBadge,
        TrnIconComponent,
        TrnProgressComponent,
        TrnSpinnerComponent,
      ],
    }),
  ],
};

export default meta;
type Story = StoryObj;

/** One canvas for verifying that every status treatment follows the active Theme tokens. */
export const SemanticStatuses: Story = {
  render: () => ({
    template: `
      <div class="grid min-w-96 gap-6 p-6">
        <div class="flex items-center gap-4">
          <trn-icon data-testid="matrix-icon-neutral" name="shield" size="lg" variant="neutral" label="Neutral" />
          <trn-icon data-testid="matrix-icon-accent" name="shield" size="lg" variant="accent" label="Accent" />
          <trn-icon data-testid="matrix-icon-muted" name="shield" size="lg" variant="muted" label="Muted" />
          <trn-icon data-testid="matrix-icon-danger" name="shield-alert" size="lg" variant="danger" label="Danger" />
        </div>
        <div class="flex items-center gap-5">
          <trn-avatar data-testid="matrix-avatar-online" name="Online" initial="O" size="xl" presence="online" />
          <trn-avatar data-testid="matrix-avatar-away" name="Away" initial="A" size="xl" presence="unavailable" />
          <trn-avatar data-testid="matrix-avatar-offline" name="Offline" initial="F" size="xl" presence="offline" />
        </div>
        <div class="flex items-center gap-3">
          <span data-testid="matrix-badge-neutral" trnBadge variant="neutral">Neutral</span>
          <span data-testid="matrix-badge-success" trnBadge variant="success">Success</span>
          <span data-testid="matrix-badge-warning" trnBadge variant="warning">Warning</span>
        </div>
        <div class="grid gap-3">
          <trn-progress data-testid="matrix-progress-accent" variant="accent" [value]="65" aria-label="Accent progress" />
          <trn-progress data-testid="matrix-progress-success" variant="success" [value]="65" aria-label="Success progress" />
          <trn-progress data-testid="matrix-progress-warning" variant="warning" [value]="65" aria-label="Warning progress" />
          <trn-progress data-testid="matrix-progress-danger" variant="danger" [value]="65" aria-label="Danger progress" />
        </div>
        <div class="flex items-center gap-4">
          <trn-spinner data-testid="matrix-spinner-neutral" variant="neutral" aria-label="Neutral loading" />
          <trn-spinner data-testid="matrix-spinner-muted" variant="muted" aria-label="Muted loading" />
          <trn-spinner data-testid="matrix-spinner-accent" variant="accent" aria-label="Accent loading" />
          <trn-spinner data-testid="matrix-spinner-danger" variant="danger" aria-label="Danger loading" />
        </div>
        <trn-banner data-testid="matrix-banner-accent" variant="accent">
          <trn-icon trnBannerIcon name="lock" />
          Attention uses the semantic surface pair.
        </trn-banner>
        <trn-empty-state data-testid="matrix-empty-danger" variant="danger" layout="line" body="A semantic failure." />
      </div>
    `,
  }),
};
