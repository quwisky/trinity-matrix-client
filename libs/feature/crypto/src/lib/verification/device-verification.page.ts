import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { TrnDialogRef } from '@trinity/components/overlay';
import { Observable } from 'rxjs';
import { TrustVerificationService } from '@trinity/data-access/trust';
import { resolveInternalReturnTo, runWithBusy } from '@trinity/util/ui';
import { PageHeaderComponent } from '@trinity/components/navigation-layout';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { QrScannerComponent } from '@trinity/components/controls';
import { QrCodeService } from '@trinity/platform-native';
import { SasCompareComponent } from './sas-compare.component';

/**
 * Drives an interactive device verification (emoji SAS) against
 * {@link TrustVerificationService}. Renders all stages — request/accept, the SAS emoji
 * comparison, and the done/cancelled outcomes. Used in two chromes: a routed page
 * (`/encryption/verify`, self-initiated) and the content of a modal (an incoming
 * request); `asModal` flips the close/finish behaviour.
 */
@Component({
  selector: 'trn-device-verification',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './device-verification.page.html',
  styleUrl: './device-verification.page.scss',
  imports: [
    NgTemplateOutlet,
    PageHeaderComponent,
    TrnButton,
    SasCompareComponent,
    QrScannerComponent,
    TrnSpinnerComponent,
  ],
})
export class DeviceVerificationPage {
  private readonly verification = inject(TrustVerificationService);
  private readonly qrCode = inject(QrCodeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  // Present only when opened as a dialog (incoming request); null on the routed page.
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef, {
    optional: true,
  });
  private readonly destroyRef = inject(DestroyRef);

  /** The active verification view (null until one starts). */
  readonly active = this.verification.active;
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  private readonly scannerRequestId = signal<number | null>(null);
  private readonly stageHeading =
    viewChild<ElementRef<HTMLHeadingElement>>('stageHeading');
  private lastFocusedView = '';
  readonly scanning = () => {
    const active = this.active();
    return (
      active?.stage === 'ready' && this.scannerRequestId() === active.requestId
    );
  };
  readonly cameraSupported = this.qrCode.cameraSupported;
  readonly qrCodeUrl = signal<string | null>(null);

  private readonly synchronizeQrUi = effect(() => {
    const active = this.active();
    const scanning = this.scanning();
    if (active?.stage !== 'qr-shown') {
      this.qrCodeUrl.set(null);
    }

    const heading = this.stageHeading();
    const view = `${active?.requestId ?? 'idle'}:${active?.stage ?? 'idle'}:${scanning}`;
    if (!heading || view === this.lastFocusedView) {
      return;
    }
    this.lastFocusedView = view;
    queueMicrotask(() => {
      const current = this.active();
      const currentView = `${current?.requestId ?? 'idle'}:${current?.stage ?? 'idle'}:${this.scanning()}`;
      if (currentView === view) {
        this.stageHeading()?.nativeElement.focus({ preventScroll: true });
      }
    });
  });

  /** When true the page is modal content (incoming); else a routed page. */
  readonly asModal = input(false);
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
    this.qrCodeUrl.set(null);
    this.run(this.verification.startSas());
  }
  showQr(): void {
    runWithBusy(this.verification.showQr(), {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((data) => this.qrCodeUrl.set(this.qrCode.createDataUrl(data)));
  }
  hideQr(): void {
    this.qrCodeUrl.set(null);
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
    this.qrCodeUrl.set(null);
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

  /** Finish: drop the verification and leave (close the modal / go to /rooms). */
  finish(): void {
    this.verification.dismiss();
    this.leave();
  }

  /** Cancel any in-flight verification, then leave. */
  cancelAndLeave(): void {
    if (this.active() && this.active()?.stage !== 'done') {
      this.verification.cancel().subscribe();
    }
    this.verification.dismiss();
    this.leave();
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
