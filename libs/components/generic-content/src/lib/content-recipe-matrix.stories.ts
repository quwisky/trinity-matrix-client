import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import {
  provideTrnIcons,
  TRN_ICON_MOTIONS,
  TRN_ICON_NAMES,
  TrnIconComponent,
  type TrnIconSize,
  type TrnIconVariant,
} from '@trinity/components/foundations';
import { TrnButton } from '@trinity/components/controls';
import { AvatarComponent } from './avatar/avatar.component';
import type { TrnAvatarSize } from './avatar/trn-avatar-size';
import type { TrnBadgeSize, TrnBadgeVariant } from './badge/trn-badge-recipe';
import { TrnBadge } from './badge/trn-badge';
import {
  BannerComponent,
  type TrnBannerVariant,
} from './banner/banner.component';
import {
  EmptyStateComponent,
  type TrnEmptyStateLayout,
  type TrnEmptyStateVariant,
} from './empty-state/empty-state.component';
import {
  TrnProgressComponent,
  type TrnProgressSize,
  type TrnProgressVariant,
} from './progress/trn-progress.component';
import {
  TrnSpinnerComponent,
  type TrnSpinnerSize,
  type TrnSpinnerVariant,
} from './spinner/trn-spinner.component';
import { TrnTooltip } from './tooltip/trn-tooltip';

const completeCatalog =
  <Union>() =>
  <const Values extends readonly Union[]>(
    values: Values & ([Union] extends [Values[number]] ? unknown : never),
  ): Values =>
    values;

const ICON_SIZES = completeCatalog<TrnIconSize>()([
  '2xs',
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
]);
const ICON_VARIANTS = completeCatalog<TrnIconVariant>()([
  'neutral',
  'accent',
  'muted',
  'danger',
]);
const AVATAR_SIZES = completeCatalog<TrnAvatarSize>()([
  '2xs',
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
]);
const BADGE_SIZES = completeCatalog<TrnBadgeSize>()(['xs', 'sm', 'md']);
const BADGE_VARIANTS = completeCatalog<TrnBadgeVariant>()([
  'neutral',
  'success',
  'warning',
]);
const BANNER_VARIANTS = completeCatalog<TrnBannerVariant>()([
  'neutral',
  'accent',
]);
const EMPTY_STATE_LAYOUTS = completeCatalog<TrnEmptyStateLayout>()([
  'panel',
  'line',
  'hero',
]);
const EMPTY_STATE_VARIANTS = completeCatalog<TrnEmptyStateVariant>()([
  'muted',
  'danger',
]);
const PROGRESS_SIZES = completeCatalog<TrnProgressSize>()(['xs', 'sm', 'md']);
const PROGRESS_VARIANTS = completeCatalog<TrnProgressVariant>()([
  'accent',
  'success',
  'warning',
  'danger',
]);
const SPINNER_SIZES = completeCatalog<TrnSpinnerSize>()([
  'xs',
  'sm',
  'md',
  'lg',
]);
const SPINNER_VARIANTS = completeCatalog<TrnSpinnerVariant>()([
  'neutral',
  'muted',
  'accent',
  'danger',
]);

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
        TrnButton,
        TrnIconComponent,
        TrnProgressComponent,
        TrnSpinnerComponent,
        TrnTooltip,
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

/**
 * The complete public Foundations and Generic Content treatment inventory in one canvas.
 * Storybook's Theme, Mode and density globals remain the only appearance switches.
 */
export const CompleteCatalog: Story = {
  render: () => ({
    props: {
      accountBadge: {
        id: '@ada:example.org',
        initial: 'A',
        name: 'Ada account',
      },
      avatarSizes: AVATAR_SIZES,
      badgeSizes: BADGE_SIZES,
      badgeVariants: BADGE_VARIANTS,
      bannerVariants: BANNER_VARIANTS,
      emptyStateLayouts: EMPTY_STATE_LAYOUTS,
      emptyStateVariants: EMPTY_STATE_VARIANTS,
      iconNames: TRN_ICON_NAMES,
      iconMotions: TRN_ICON_MOTIONS,
      iconSizes: ICON_SIZES,
      iconVariants: ICON_VARIANTS,
      progressSizes: PROGRESS_SIZES,
      progressVariants: PROGRESS_VARIANTS,
      spinnerSizes: SPINNER_SIZES,
      spinnerVariants: SPINNER_VARIANTS,
    },
    template: `
      <main class="grid min-w-96 gap-10 p-6" data-testid="complete-content-catalog">
        <h1 class="text-xl font-semibold">Foundations and Generic Content catalog</h1>

        <section class="grid gap-4" aria-labelledby="catalog-icons">
          <h2 id="catalog-icons" class="text-lg font-semibold">Icons</h2>
          <div class="flex flex-wrap items-end gap-4">
            @for (size of iconSizes; track size) {
              <trn-icon [attr.data-testid]="'catalog-icon-size-' + size" name="star" [size]="size" [label]="size + ' icon'" />
            }
          </div>
          <div class="flex flex-wrap gap-4">
            @for (variant of iconVariants; track variant) {
              <trn-icon [attr.data-testid]="'catalog-icon-variant-' + variant" name="shield" size="lg" [variant]="variant" [label]="variant + ' icon'" />
            }
            <trn-icon data-testid="catalog-icon-decorative" name="star" />
          </div>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
            @for (name of iconNames; track name) {
              <span class="flex items-center gap-2 text-xs">
                <trn-icon [name]="name" [label]="name" />{{ name }}
              </span>
            }
          </div>
          <div class="flex flex-wrap gap-3">
            @for (motion of iconMotions; track motion) {
              <span class="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
                <trn-icon name="star" [motion]="motion" [label]="motion + ' motion'" />
                {{ motion }}
              </span>
            }
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-avatars">
          <h2 id="catalog-avatars" class="text-lg font-semibold">Avatars</h2>
          <div class="flex flex-wrap items-end gap-4">
            @for (size of avatarSizes; track size) {
              <trn-avatar [attr.data-testid]="'catalog-avatar-size-' + size" name="Ada" initial="A" [size]="size" />
            }
            <trn-avatar data-testid="catalog-avatar-exact" name="Exact" initial="E" size="2xs" [exactSize]="72" />
          </div>
          <div class="flex flex-wrap items-end gap-5">
            <trn-avatar name="Person fallback" initial="P" shape="person" presence="online" />
            <trn-avatar name="Place fallback" initial="R" shape="place" presence="unavailable" />
            <trn-avatar name="Offline account" initial="O" presence="offline" [accountBadge]="accountBadge" />
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-badges">
          <h2 id="catalog-badges" class="text-lg font-semibold">Badges</h2>
          <div class="flex flex-wrap items-center gap-3">
            @for (variant of badgeVariants; track variant) {
              @for (size of badgeSizes; track size) {
                <span [attr.data-testid]="'catalog-badge-' + variant + '-' + size" trnBadge [variant]="variant" [size]="size">
                  {{ variant }} {{ size }}
                </span>
              }
            }
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-banners">
          <h2 id="catalog-banners" class="text-lg font-semibold">Banners</h2>
          @for (variant of bannerVariants; track variant) {
            <trn-banner [attr.data-testid]="'catalog-banner-' + variant" [variant]="variant">
              <trn-icon trnBannerIcon name="lock" />
              {{ variant }} treatment with wrapping copy that remains readable at narrow widths.
              @if (variant === 'accent') {
                <span trnBannerActions><button trnBtn size="sm">Set up</button></span>
              }
            </trn-banner>
          }
          <trn-banner data-testid="catalog-banner-disabled" variant="neutral">
            <trn-icon trnBannerIcon name="cloud-off" />
            Disabled keeps native semantics.
            <span trnBannerActions><button trnBtn size="sm" disabled>Retry</button></span>
          </trn-banner>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-empty-states">
          <h2 id="catalog-empty-states" class="text-lg font-semibold">Empty states</h2>
          <div class="grid gap-4 md:grid-cols-3">
            @for (variant of emptyStateVariants; track variant) {
              @for (layout of emptyStateLayouts; track layout) {
                <trn-empty-state
                  [attr.data-testid]="'catalog-empty-' + variant + '-' + layout"
                  [layout]="layout"
                  [variant]="variant"
                  icon="search"
                  [title]="variant + ' ' + layout"
                  body="Try another search."
                  [titleAs]="layout === 'hero' ? 'h2' : 'p'"
                />
              }
            }
            <trn-empty-state data-testid="catalog-empty-loading" title="Loading rooms">
              <trn-spinner aria-label="Loading rooms" />
            </trn-empty-state>
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-progress">
          <h2 id="catalog-progress" class="text-lg font-semibold">Progress</h2>
          @for (variant of progressVariants; track variant) {
            <div class="grid gap-3">
              @for (size of progressSizes; track size) {
                <trn-progress [attr.data-testid]="'catalog-progress-' + variant + '-' + size" [variant]="variant" [size]="size" [value]="65" [aria-label]="variant + ' ' + size + ' progress'" />
              }
            </div>
          }
          <trn-progress data-testid="catalog-progress-indeterminate" [value]="null" aria-label="Indeterminate progress" />
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-spinners">
          <h2 id="catalog-spinners" class="text-lg font-semibold">Spinners</h2>
          <div class="flex flex-wrap items-center gap-4">
            @for (variant of spinnerVariants; track variant) {
              @for (size of spinnerSizes; track size) {
                <trn-spinner [attr.data-testid]="'catalog-spinner-' + variant + '-' + size" [variant]="variant" [size]="size" [aria-label]="variant + ' ' + size + ' loading'" />
              }
            }
            <span class="text-[var(--trinity-link)]">
              <trn-spinner data-testid="catalog-spinner-inherited" aria-label="Inherited loading" />
            </span>
          </div>
        </section>

        <section class="grid gap-4" aria-labelledby="catalog-tooltips">
          <h2 id="catalog-tooltips" class="text-lg font-semibold">Tooltips</h2>
          <div class="flex flex-wrap gap-3">
            <button data-testid="catalog-tooltip-top" trnBtn trnTooltip="Above" position="top">Top</button>
            <button trnBtn trnTooltip="Right" position="right">Right</button>
            <button trnBtn trnTooltip="Below" position="bottom">Bottom</button>
            <button trnBtn trnTooltip="Left" position="left">Left</button>
          </div>
        </section>
      </main>
    `,
  }),
};
