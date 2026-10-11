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
import { BannerComponent } from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';

/** Which encryption flow a banner action triggers. */
type BannerActionKind = 'setup' | 'unlock' | 'verify' | 'reset';

/** A banner call-to-action: a label, the flow it triggers and its weight. */
interface BannerAction {
  label: string;
  kind: BannerActionKind;
  /** Subordinate actions (an irreversible door) recede rather than invite. */
  secondary?: true;
}

/**
 * Non-blocking, persistent prompt shown in the rooms shell when this device's encryption
 * isn't ready (MSC4153 decision 3: existing unverified devices are prompted, never
 * blocked). Reads {@link TrustService.status}: `needs-setup` offers first-time setup;
 * `needs-recovery` offers both ways to trust this device — the recovery key or verifying
 * with another signed-in session; `needs-verification` (an identity set up elsewhere,
 * with no recovery) offers only verification, because setup would replace that identity.
 * A verified device that still lacks that identity's keys (`recoverySetupElsewhere`) is
 * sent to the device that holds them, with the explicit reset as the only action here.
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

  readonly message = computed(() => {
    if (this.setupElsewhere()) {
      return 'Set up recovery on the device where you first set up encryption.';
    }
    switch (this.status()) {
      case 'needs-recovery':
        return "This device isn't verified yet — unlock your encrypted messages.";
      case 'needs-verification':
        return "This device isn't verified yet — verify it with one of your other devices.";
      default:
        return 'Set up encryption to secure your messages.';
    }
  });

  readonly actions = computed<BannerAction[]>(() => {
    if (this.setupElsewhere()) {
      // No "Set up": it would replace the identity the other device holds.
      return [{ label: 'Reset my identity', kind: 'reset', secondary: true }];
    }
    switch (this.status()) {
      case 'needs-setup':
        return [{ label: 'Set up', kind: 'setup' }];
      case 'needs-recovery':
        return [
          { label: 'Use recovery key', kind: 'unlock' },
          { label: 'Verify another device', kind: 'verify' },
        ];
      case 'needs-verification':
        return [{ label: 'Verify another device', kind: 'verify' }];
      default:
        return [];
    }
  });

  /**
   * Trigger a semantic trust surface. The application adapter chooses a modal or
   * canonical route without exposing Router or platform policy to this capability.
   */
  run(kind: BannerActionKind): void {
    // The reset lives on the unlock screen, behind its typed confirmation: one
    // implementation of an irreversible flow, arrived at with the reset offered.
    const request: WorkspaceApplicationSurfaceRequest =
      kind === 'reset'
        ? {
            surface: { kind: 'trust', flow: 'unlock' },
            context: { offerReset: true },
          }
        : { surface: { kind: 'trust', flow: kind } };
    this.applicationSurfaces
      .open(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}
