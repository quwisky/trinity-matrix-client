import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogRef } from '@angular/cdk/dialog';
import { Observable } from 'rxjs';
import { CryptoService } from '@trinity/core';
import { resolveInternalReturnTo, runWithBusy } from '@trinity/ui';
import { HlmButton, HlmInput, HlmLabel, HlmSpinner } from '@trinity/ui-spartan';

/**
 * New-device unlock (flow B). The account already has secret storage; the user
 * enters their recovery key to trust this device — {@link CryptoService.recoverWithKey}
 * imports the cross-signing secrets and enables key backup. Key-only by design:
 * Trinity provisions a random recovery key (no passphrase) during setup.
 */
@Component({
  selector: 'trn-encryption-unlock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'encryption-unlock.page.html',
  styleUrls: ['encryption-unlock.page.scss'],
  imports: [
    FormsModule,
    NgTemplateOutlet,
    HlmButton,
    HlmInput,
    HlmLabel,
    HlmSpinner,
  ],
})
export class EncryptionUnlockPage {
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  // Present only when opened as a dialog (desktop); null on the routed page.
  private readonly dialogRef = inject<DialogRef<void, EncryptionUnlockPage>>(
    DialogRef,
    { optional: true },
  );
  private readonly destroyRef = inject(DestroyRef);

  readonly recoveryKey = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** When true the page is modal content (desktop); else a routed page. */
  readonly asModal = input(false);
  /** Asks an @Output-bound host modal to dismiss. */
  readonly closed = output<void>();

  /** Unlock this device from the entered recovery key. */
  unlock(): void {
    const key = this.recoveryKey().trim();
    if (!key) {
      return;
    }
    this.withBusy(this.crypto.recoverWithKey(key)).subscribe(() => {
      this.recoveryKey.set(''); // drop the key from memory once it's been used
      this.leave();
    });
  }

  /** Close without unlocking (modal Close / return on the routed page). */
  close(): void {
    this.recoveryKey.set('');
    this.leave();
  }

  /** Close the dialog, or (routed) return to the launch route / /rooms. */
  private leave(): void {
    if (this.asModal()) {
      // @Outputs aren't bound on dialog-created components, so close the host
      // dialog ourselves; `closed` stays for any @Output-bound host.
      this.closed.emit();
      this.dialogRef?.close();
      return;
    }
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    void this.router.navigateByUrl(resolveInternalReturnTo(returnTo), {
      replaceUrl: true,
    });
  }

  /** Wrap a one-shot action with shared busy/error handling. */
  private withBusy<T>(source: Observable<T>): Observable<T> {
    return runWithBusy(source, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    });
  }
}
