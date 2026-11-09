import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { recoveryHeading } from './app-lock-cover.copy';
import type { CoverView } from './app-lock-cover.state';

/** The views that unlock; every other view is a recovery step with its own heading. */
export function isUnlockView(view: CoverView): boolean {
  return view === 'system' || view === 'pin';
}

/**
 * The lock screen's heading: the app's mark and "… is locked" over an unlock view, or the
 * step's icon and heading over a recovery view, with the app's name kept small above it.
 * Either way `#app-lock-heading` names the dialog.
 */
@Component({
  selector: 'trn-app-lock-cover-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-cover-header.component.html',
  imports: [TrnIconComponent],
  host: { class: 'contents' },
})
export class AppLockCoverHeaderComponent {
  readonly view = input.required<CoverView>();
  readonly appName = input.required<string>();

  protected readonly unlockView = computed(() => isUnlockView(this.view()));
  protected readonly recoveryHeading = computed(() =>
    recoveryHeading(this.view()),
  );
  protected readonly recoveryIcon = computed(
    () => RECOVERY_LOOK[this.view()].icon,
  );
  protected readonly recoveryToneClass = computed(
    () => TONE_CLASS[RECOVERY_LOOK[this.view()].tone],
  );
}

type RecoveryTone = 'accent' | 'warning' | 'danger';

const TONE_CLASS: Readonly<Record<RecoveryTone, string>> = {
  accent:
    'bg-[color-mix(in_oklch,var(--trinity-accent)_14%,var(--trinity-surface-app))] text-[var(--trinity-accent)]',
  warning:
    'bg-[color-mix(in_oklch,var(--trinity-warning)_14%,var(--trinity-surface-app))] text-[var(--trinity-warning)]',
  danger:
    'bg-[color-mix(in_oklch,var(--trinity-danger)_14%,var(--trinity-surface-app))] text-[var(--trinity-danger)]',
};

/** A recovery view's mark; the unlock views show the app's own and never read theirs. */
const RECOVERY_LOOK = {
  system: { icon: 'lock', tone: 'accent' },
  pin: { icon: 'lock', tone: 'accent' },
  'pin-unreadable': { icon: 'triangle-alert', tone: 'warning' },
  'no-pin': { icon: 'shield-alert', tone: 'warning' },
  'no-pin-store': { icon: 'shield-alert', tone: 'warning' },
  forgot: { icon: 'key-round', tone: 'accent' },
  erase: { icon: 'trash-2', tone: 'danger' },
} as const satisfies Record<
  CoverView,
  { readonly icon: TrnIconName; readonly tone: RecoveryTone }
>;
