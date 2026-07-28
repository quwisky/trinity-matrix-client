import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormField, disabled, form } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogRef } from '@angular/cdk/dialog';
import { Observable } from 'rxjs';
import { CryptoService } from '@trinity/data-access-crypto';
import {
  PageHeaderComponent,
  resolveInternalReturnTo,
  runWithBusy,
} from '@trinity/ui';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { HlmSpinner } from '@trinity/helm/spinner';

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
    FormField,
    NgTemplateOutlet,
    PageHeaderComponent,
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

  readonly busy = signal(false);

  private readonly keyModel = signal({ recoveryKey: '' });
  // Disabled belongs to the schema, not to a [disabled] binding on the input: Signal
  // Forms owns the field's disabled state and rejects the binding at compile time
  // (NG8022). Declared after `busy` because the schema reads it.
  readonly unlockForm = form(this.keyModel, (path) => {
    disabled(path.recoveryKey, { when: () => this.busy() });
  });
  /** Whether there is a key to try — keeps the trim out of the template. */
  readonly hasKey = computed(
    () => this.keyModel().recoveryKey.trim().length > 0,
  );
  readonly error = signal<string | null>(null);

  /** When true the page is modal content (desktop); else a routed page. */
  readonly asModal = input(false);
  /** Asks an @Output-bound host modal to dismiss. */
  readonly closed = output<void>();

  /** Unlock this device from the entered recovery key. */
  unlock(): void {
    const key = this.keyModel().recoveryKey.trim();
    if (!key) {
      return;
    }
    this.withBusy(this.crypto.recoverWithKey(key)).subscribe(() => {
      this.clearKey(); // drop the key from memory once it's been used
      this.leave();
    });
  }

  /** Close without unlocking (modal Close / return on the routed page). */
  close(): void {
    this.clearKey();
    this.leave();
  }

  /**
   * Wipe the entered key. `reset` rather than a bare model write so the field's
   * touched/dirty state goes with it — this runs on the security-relevant path where
   * the key must not outlive its use.
   */
  private clearKey(): void {
    this.unlockForm().reset({ recoveryKey: '' });
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
