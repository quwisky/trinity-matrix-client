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
  type SlotForecast,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import {
  BannerComponent,
  type TrnBannerPlacement,
} from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrustService } from '@trinity/data-access/trust';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';

/** Which surface a banner action opens: an encryption flow, or Security settings. */
type BannerActionKind = 'setup' | 'unlock' | 'verify' | 'security';

/** A banner call-to-action: a label and the surface it opens. */
interface BannerAction {
  label: string;
  kind: BannerActionKind;
}

/**
 * Non-blocking prompt, dismissible for the session, shown in the rooms shell when this device's encryption
 * isn't ready (MSC4153: existing unverified devices are prompted, never blocked). Renders the
 * prompt the global banner slot holds (`bannerPrompt`), never the live trust status, so the
 * slot owner can hold the prompt while a pointer is pressed.
 * - `needs-setup`: first-time setup.
 * - `needs-recovery`: the recovery key, or verifying with another signed-in session.
 * - `needs-verification` (identity set up elsewhere, no recovery): verification only,
 *   because setup would replace that identity.
 * - `setup-elsewhere` (verified device still lacking that identity's keys): sent to the
 *   device that holds them; its only action opens Security settings.
 * Dismissing hides it until the app starts again; Settings › Security still offers every
 * action. The banner never offers the irreversible reset; that stays in Security settings,
 * behind its typed confirmation.
 * A placeholder prompt (a forecast before the live status arrives, or a held prompt the live
 * status no longer supports) is laid out hidden, unannounced and inert, so it holds its exact
 * space; a confirmed forecast is the same element, revealed in place. The status is the
 * ACTIVE account's, re-projected on an account switch. Lives in feature-rooms because the
 * module boundary forbids feature-to-feature dependencies.
 */
@Component({
  selector: 'trn-encryption-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['encryption-banner.component.scss'],
  imports: [TrnIconComponent, TrnButton, BannerComponent],
  templateUrl: './encryption-banner.component.html',
})
export class EncryptionBannerComponent {
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly systemStatus = inject(WORKSPACE_SYSTEM_STATUS);
  private readonly trust = inject(TrustService);
  private readonly destroyRef = inject(DestroyRef);
  /** The prompt the slot holds; null when the slot holds no encryption prompt. */
  private readonly slotPrompt = this.systemStatus.bannerPrompt;
  private readonly kind = computed(() => this.slotPrompt()?.kind ?? null);

  /** The phone layout: one line, the primary action and Dismiss, on a quieter surface. */
  readonly compact = mediaQuerySignal(BELOW_MD_QUERY, inject(DestroyRef));

  /** A placeholder prompt: laid out to hold its space, but hidden, unannounced and inert. */
  readonly pending = computed(() => this.slotPrompt()?.placeholder ?? false);

  /** Lay out a prompt only while it owns the global banner slot. */
  readonly visible = computed(() => this.slotPrompt() !== null);

  /**
   * Keep the two-action notice's height only where this prompt may replace it: in a slot
   * that never held the notice the prompt replaces nothing and keeps its own height.
   */
  readonly placement = computed<TrnBannerPlacement>(() =>
    this.systemStatus.bannerSlotReserved() ? 'global' : 'inline',
  );

  readonly message = computed(() => fullMessage(this.kind()));

  /**
   * What a screen reader hears: the confirmed prompt, even while the slot holds it back,
   * since announcing moves nothing.
   */
  readonly announcement = computed(() => {
    const kind = this.systemStatus.announcedPrompt();
    return kind ? fullMessage(kind) : '';
  });

  /** The same prompt in one short line; the live region still reads {@link message}. */
  readonly shortMessage = computed(() => {
    switch (this.kind()) {
      case 'setup-elsewhere':
        return 'Set up recovery on your first device.';
      case 'needs-recovery':
      case 'needs-verification':
        return 'This device isn’t verified.';
      default:
        return 'Encryption isn’t set up.';
    }
  });

  /** On a phone only the primary action shows; the others are in Settings › Security. */
  readonly shownActions = computed(() =>
    this.compact() ? this.actions().slice(0, 1) : this.actions(),
  );

  readonly actions = computed<BannerAction[]>(() => {
    switch (this.kind()) {
      case 'setup-elsewhere':
        // No "Set up": it would replace the identity the other device holds. Security
        // settings explains the way out, including the confirmed reset.
        return [{ label: 'Security settings', kind: 'security' }];
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
  /** Hide the prompt for this session; setup stays in Settings › Security. */
  dismiss(): void {
    this.systemStatus.dismissEncryption();
  }

  /**
   * Open a trust surface or Security settings. The application adapter picks a modal or
   * route, keeping Router and platform policy out of this capability. A trust surface is
   * given the Account on screen at the press, so it cannot act for one that replaces it.
   */
  run(kind: BannerActionKind): void {
    const accountId = this.trust.activeAccountId();
    const request: WorkspaceApplicationSurfaceRequest =
      kind === 'security'
        ? { surface: { kind: 'settings', section: 'security' } }
        : {
            surface: { kind: 'trust', flow: kind },
            ...(accountId ? { context: { accountId } } : {}),
          };
    this.applicationSurfaces
      .open(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}

function fullMessage(kind: SlotForecast | null): string {
  switch (kind) {
    case 'setup-elsewhere':
      return 'Set up recovery on the device where you first set up encryption.';
    case 'needs-recovery':
      return 'This device isn’t verified yet — unlock your encrypted messages.';
    case 'needs-verification':
      return 'This device isn’t verified yet — verify it with one of your other devices.';
    default:
      return 'Set up encryption to secure your messages.';
  }
}
