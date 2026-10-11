import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import { Observable } from 'rxjs';
import {
  MANAGE_IDENTITY,
  TrustService,
  TrustVerificationService,
  type TrustDialogResult,
} from '@trinity/data-access/trust';
import { resolveInternalReturnTo, runWithBusy } from '@trinity/util/ui';
import {
  PageHeaderComponent,
  TrnCardImports,
} from '@trinity/components/navigation-layout';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { QrScannerComponent } from '@trinity/components/controls';
import { DateTimeFormatService, QrCodeService } from '@trinity/platform-native';
import { SasCompareComponent } from './sas-compare.component';

/**
 * Drives an interactive device verification (emoji SAS) against
 * {@link TrustVerificationService}. Renders all stages — request/accept, the SAS emoji
 * comparison, and the done/cancelled outcomes. Used in two chromes: a routed page
 * (`/encryption/verify`) and the content of a modal, opened either by the application
 * presenter (a self-initiated flow on a wide layout) or by the verification host (an
 * incoming or cross-user request); `asModal` flips the close/finish behaviour.
 */
@Component({
  selector: 'trn-device-verification',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './device-verification.page.html',
  styleUrl: './device-verification.page.scss',
  imports: [
    TrnCardImports,
    NgTemplateOutlet,
    PageHeaderComponent,
    TrnButton,
    TrnDialogShellComponent,
    SasCompareComponent,
    QrScannerComponent,
    TrnSpinnerComponent,
  ],
})
export class DeviceVerificationPage {
  private readonly verification = inject(TrustVerificationService);
  private readonly trust = inject(TrustService);
  private readonly qrCode = inject(QrCodeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  // Present only when opened as a dialog (by the presenter or the verification host);
  // null on the routed page.
  private readonly dialogRef = inject<TrnDialogRef<TrustDialogResult>>(
    TrnDialogRef,
    { optional: true },
  );
  private readonly destroyRef = inject(DestroyRef);

  /** The active verification view (null until one starts). */
  readonly active = this.verification.active;
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  private readonly scannerRequestId = signal<number | null>(null);
  private readonly stageHeading =
    viewChild<ElementRef<HTMLHeadingElement>>('stageHeading');
  // Declining, the default answer to a request for access, takes the first focus.
  private readonly initialFocus = viewChild('initialFocus', {
    read: ElementRef<HTMLElement>,
  });
  private lastFocusedView = '';
  readonly scanning = () => {
    const active = this.active();
    return (
      active?.stage === 'ready' && this.scannerRequestId() === active.requestId
    );
  };
  readonly cameraSupported = this.qrCode.cameraSupported;
  readonly fmt = inject(DateTimeFormatService);
  readonly qrCodeUrl = signal<string | null>(null);
  private qrRequest = 0;

  /**
   * An identity set up elsewhere without recovery can only be verified from a device that
   * holds it. Before this device sends a request, while its own request is unanswered, or
   * once it has stopped, point someone without that device to Security settings, where the confirmed reset lives;
   * this dialog never offers the reset itself. A modal offers it only when its opener said
   * closing can land there.
   */
  readonly offerSecuritySettings = computed(() => {
    if (
      this.trust.status() !== 'needs-verification' ||
      (this.asModal() && !this.canOpenSecuritySettings())
    ) {
      return false;
    }
    const active = this.active();
    return (
      !active ||
      (active.isSelfVerification &&
        !active.incoming &&
        (active.stage === 'requested' || active.stage === 'cancelled'))
    );
  });

  private readonly synchronizeQrUi = effect(() => {
    if (this.active()?.stage !== 'qr-shown') {
      this.clearQr();
    }

    const target = this.initialFocus() ?? this.stageHeading();
    const view = this.focusView();
    if (!target || view === this.lastFocusedView) {
      return;
    }
    this.lastFocusedView = view;
    queueMicrotask(() => {
      if (this.focusView() === view) {
        (this.initialFocus() ?? this.stageHeading())?.nativeElement.focus({
          preventScroll: true,
        });
      }
    });
  });

  /** When true the page is dialog content (an incoming request, or one this device opened); else a routed page. */
  readonly asModal = input(false);
  /**
   * Set by the application presenter when closing this modal with `MANAGE_IDENTITY` lands
   * in Security settings: it opens Settings there, or Security is already beneath. Not set
   * over another Settings section, where the button's label would not be true.
   */
  readonly canOpenSecuritySettings = input(false);
  /** Asks the host modal to dismiss. */
  readonly closed = output<void>();

  start(): void {
    this.run(this.verification.startSelfVerification());
  }
  accept(): void {
    this.run(this.verification.accept());
  }
  startSas(): void {
    this.scannerRequestId.set(null);
    this.clearQr();
    this.run(this.verification.startSas());
  }
  showQr(): void {
    runWithBusy(this.verification.showQr(), {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((data) => {
      const request = ++this.qrRequest;
      this.qrCode
        .createDataUrl(data)
        .then((url) => {
          if (request === this.qrRequest) {
            this.qrCodeUrl.set(url);
          }
        })
        .catch(() => {
          if (request === this.qrRequest) {
            this.error.set('Couldn’t render the QR code.');
          }
        });
    });
  }
  hideQr(): void {
    this.clearQr();
    this.verification.hideQr();
  }
  startQrScan(): void {
    this.error.set(null);
    this.scannerRequestId.set(this.active()?.requestId ?? null);
  }
  cancelQrScan(): void {
    this.scannerRequestId.set(null);
  }
  scanQr(data: Uint8ClampedArray): void {
    this.scannerRequestId.set(null);
    this.clearQr();
    this.run(this.verification.scanQr(data));
  }
  confirmQr(): void {
    this.run(this.verification.confirmQr());
  }
  confirm(): void {
    this.run(this.verification.confirmSas());
  }
  reportMismatch(): void {
    this.run(this.verification.mismatchSas());
  }
  cancel(): void {
    this.run(this.verification.cancel());
  }

  /** What focus belongs to: the request, its stage, and which element takes it. */
  private focusView(): string {
    const active = this.active();
    const taker = this.initialFocus() ? 'answer' : 'heading';
    return `${active?.requestId ?? 'idle'}:${active?.stage ?? 'idle'}:${this.scanning()}:${taker}`;
  }

  /** Drop the sensitive code and any render still in flight. */
  private clearQr(): void {
    this.qrRequest++;
    this.qrCodeUrl.set(null);
  }

  /** Finish: drop the verification and leave (close the modal / go to /rooms). */
  finish(): void {
    this.verification.dismiss();
    this.leave();
  }

  /** Cancel any in-flight verification, then leave. */
  cancelAndLeave(): void {
    this.cancelInFlight();
    this.leave();
  }

  /**
   * Drop the unanswered request and go to Security settings: navigate on the routed page,
   * or close the modal asking its opener to present Settings there.
   */
  openSecuritySettings(): void {
    // The other device may have answered since the button was last rendered.
    if (!this.offerSecuritySettings()) {
      return;
    }
    if (this.asModal()) {
      // Close with the result before dismissing, so the result is set however the dialog's
      // host reacts to `active()` clearing.
      this.closed.emit();
      this.dialogRef?.close(MANAGE_IDENTITY);
      this.cancelInFlight();
      return;
    }
    this.cancelInFlight();
    void this.router.navigateByUrl('/settings/security', { replaceUrl: true });
  }

  /** Cancel a verification still running (not one already finished), then drop it. */
  private cancelInFlight(): void {
    const stage = this.active()?.stage;
    if (stage && stage !== 'done' && stage !== 'cancelled') {
      this.verification.cancel().subscribe();
    }
    this.verification.dismiss();
  }

  private leave(): void {
    if (this.asModal()) {
      // @Outputs aren't bound on dialog-created components, so close the host
      // dialog ourselves; `closed` is still emitted for any @Output-bound host.
      // The incoming-request dialog is also owned by VerificationHostComponent,
      // which closes it once `active()` clears — CDK's close() is idempotent, so
      // either path (or both) tears the dialog down exactly once.
      this.closed.emit();
      this.dialogRef?.close();
      return;
    }
    // Return to where the flow was launched from (e.g. /settings), defaulting to
    // /rooms; off-app targets are rejected by resolveInternalReturnTo.
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    void this.router.navigateByUrl(resolveInternalReturnTo(returnTo), {
      replaceUrl: true,
    });
  }

  private run(action: Observable<void>): void {
    runWithBusy(action, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe();
  }
}
