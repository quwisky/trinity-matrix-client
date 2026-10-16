import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  WORKSPACE_SYSTEM_STATUS,
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrustService } from '@trinity/data-access/trust';
import {
  BannerComponent,
  type TrnBannerPlacement,
} from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';

/** Which surface a banner action opens: an encryption flow, or Security settings. */
type BannerActionKind = 'setup' | 'unlock' | 'verify' | 'security';

/** A banner call-to-action: a label and the surface it opens. */
interface BannerAction {
  label: string;
  kind: BannerActionKind;
}

/**
 * Non-blocking, persistent prompt shown in the rooms shell when this device's encryption
 * isn't ready (MSC4153 decision 3: existing unverified devices are prompted, never
 * blocked). Reads {@link TrustService.status}: `needs-setup` offers first-time setup;
 * `needs-recovery` offers both ways to trust this device — the recovery key or verifying
 * with another signed-in session; `needs-verification` (an identity set up elsewhere,
 * with no recovery) offers only verification, because setup would replace that identity.
 * A verified device that still lacks that identity's keys (`recoverySetupElsewhere`) is
 * sent to the device that holds them; its only action opens Security settings. The
 * banner cannot be dismissed, so it never offers the irreversible reset itself — that
 * stays in Security settings, behind its typed confirmation.
 * Renders nothing when crypto is `ready` or still `unknown`. Its status is the ACTIVE
 * account's, re-projected on an account switch. Lives in feature-rooms (not
 * feature-crypto) because the module boundary forbids feature→feature dependencies.
 */
@Component({
  selector: 'trn-encryption-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['encryption-banner.component.scss'],
  imports: [TrnIconComponent, TrnButton, BannerComponent],
  templateUrl: './encryption-banner.component.html',
})
export class EncryptionBannerComponent {
  private readonly crypto = inject(TrustService);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly systemStatus = inject(WORKSPACE_SYSTEM_STATUS);
  private readonly destroyRef = inject(DestroyRef);

  readonly status = this.crypto.status;
  /** Verified here, but only the device holding the identity can set up recovery. */
  readonly setupElsewhere = this.crypto.recoverySetupElsewhere;

  /** Only prompt for the actionable states, and only while it owns the global banner slot. */
  readonly visible = computed(() => {
    const status = this.status();
    return (
      (status === 'needs-setup' ||
        status === 'needs-recovery' ||
        status === 'needs-verification') &&
      this.systemStatus.bannerSlot() === 'encryption'
    );
  });

  /**
   * Keep the two-action notice's height only where this prompt may replace it: in a slot
   * that never held the notice the prompt replaces nothing and keeps its own height.
   */
  readonly placement = computed<TrnBannerPlacement>(() =>
    this.systemStatus.bannerSlotReserved() ? 'global' : 'inline',
  );

  readonly message = computed(() => {
    if (this.setupElsewhere()) {
      return 'Set up recovery on the device where you first set up encryption.';
    }
    switch (this.status()) {
      case 'needs-recovery':
        return 'This device isn’t verified yet — unlock your encrypted messages.';
      case 'needs-verification':
        return 'This device isn’t verified yet — verify it with one of your other devices.';
      default:
        return 'Set up encryption to secure your messages.';
    }
  });

  readonly actions = computed<BannerAction[]>(() => {
    if (this.setupElsewhere()) {
      // No "Set up": it would replace the identity the other device holds. Security
      // settings explains the way out, including the confirmed reset.
      return [{ label: 'Security settings', kind: 'security' }];
    }
    switch (this.status()) {
      case 'needs-setup':
        return [{ label: 'Set up', kind: 'setup' }];
      case 'needs-recovery':
        return [
          { label: 'Use recovery key', kind: 'unlock' },
          { label: 'Verify with another device', kind: 'verify' },
        ];
      case 'needs-verification':
        return [{ label: 'Verify with another device', kind: 'verify' }];
      default:
        return [];
    }
  });

  /**
   * Open a semantic trust surface, or Security settings. The application adapter chooses
   * a modal or canonical route without exposing Router or platform policy to this
   * capability.
   */
  run(kind: BannerActionKind): void {
    const request: WorkspaceApplicationSurfaceRequest =
      kind === 'security'
        ? { surface: { kind: 'settings', section: 'security' } }
        : { surface: { kind: 'trust', flow: kind } };
    this.applicationSurfaces
      .open(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}
