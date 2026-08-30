import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/button';
import { TrustService } from '@trinity/data-access/trust';
import { BannerComponent } from '@trinity/components/banner';
import { TrnIconComponent } from '@trinity/components/icon';

/** Which encryption flow a banner action triggers. */
type BannerActionKind = 'setup' | 'unlock' | 'verify';

/** A banner call-to-action: a label and the flow it triggers. */
interface BannerAction {
  label: string;
  kind: BannerActionKind;
}

/**
 * Non-blocking prompt shown in the rooms shell when this device's encryption
 * isn't ready. Reads {@link TrustService.status}: `needs-setup` offers first-time
 * setup; `needs-recovery` offers both ways to trust this device — the recovery key
 * or verifying with another signed-in session. Renders nothing when crypto is
 * `ready` or still `unknown`. Its status is the ACTIVE account's, re-projected on an
 * account switch, so the prompt always reflects the account in view. Lives in
 * feature-rooms (not feature-crypto) because the module boundary forbids
 * feature→feature dependencies; it depends only on `@trinity/data-access/trust`.
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
  private readonly destroyRef = inject(DestroyRef);

  readonly status = this.crypto.status;

  /** Only prompt for the two actionable states. */
  readonly visible = computed(() => {
    const status = this.status();
    return status === 'needs-setup' || status === 'needs-recovery';
  });

  readonly message = computed(() =>
    this.status() === 'needs-recovery'
      ? "This device isn't verified yet — unlock your encrypted messages."
      : 'Set up encryption to secure your messages.',
  );

  readonly actions = computed<BannerAction[]>(() => {
    switch (this.status()) {
      case 'needs-setup':
        return [{ label: 'Set up', kind: 'setup' }];
      case 'needs-recovery':
        return [
          { label: 'Use recovery key', kind: 'unlock' },
          { label: 'Verify another device', kind: 'verify' },
        ];
      default:
        return [];
    }
  });

  /**
   * Trigger a semantic trust surface. The application adapter chooses a modal or
   * canonical route without exposing Router or platform policy to this capability.
   */
  run(kind: BannerActionKind): void {
    this.applicationSurfaces
      .open({ surface: { kind: 'trust', flow: kind } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}
