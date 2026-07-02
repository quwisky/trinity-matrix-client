import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable } from 'rxjs';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonButtons,
  ModalController,
} from '@ionic/angular/standalone';
import { VerificationService } from '@trinity/core';
import { resolveInternalReturnTo, runWithBusy } from '@trinity/ui';
import { TrnSpinnerComponent } from '@trinity/ui-spartan';
import { SasCompareComponent } from './sas-compare.component';

/**
 * Drives an interactive device verification (emoji SAS) against
 * {@link VerificationService}. Renders all stages — request/accept, the SAS emoji
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
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButton,
    IonButtons,
    SasCompareComponent,
    TrnSpinnerComponent,
  ],
})
export class DeviceVerificationPage {
  private readonly verification = inject(VerificationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly modalCtrl = inject(ModalController);
  private readonly destroyRef = inject(DestroyRef);

  /** The active verification view (null until one starts). */
  readonly active = this.verification.active;
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

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
    this.run(this.verification.startSas());
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
      // @Outputs aren't bound on ModalController-created components, so dismiss
      // the host modal ourselves; `closed` is still emitted for any future
      // @Output-bound host. The incoming-request modal is owned by
      // VerificationHostComponent, which closes it once `active()` clears — the
      // getTop() guard below keeps that from double-dismissing.
      this.closed.emit();
      void this.dismissTopModal();
      return;
    }
    // Return to where the flow was launched from (e.g. /settings), defaulting to
    // /rooms; off-app targets are rejected by resolveInternalReturnTo.
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    void this.router.navigateByUrl(resolveInternalReturnTo(returnTo), {
      replaceUrl: true,
    });
  }

  /**
   * Dismiss the modal that hosts us, if one is still presented. Guarded via
   * `getTop()` so we never double-dismiss when VerificationHostComponent has
   * already closed the incoming-request modal after `active()` cleared.
   */
  private async dismissTopModal(): Promise<void> {
    const top = await this.modalCtrl.getTop();
    await top?.dismiss();
  }

  private run(action: Observable<void>): void {
    runWithBusy(action, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe();
  }
}
