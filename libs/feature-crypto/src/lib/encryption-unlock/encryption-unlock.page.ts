import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { EMPTY, Observable, catchError, finalize } from 'rxjs';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonList,
  IonItem,
  IonInput,
  IonButton,
  IonText,
  IonSpinner,
} from '@ionic/angular/standalone';
import { CryptoService } from '@trinity/core';

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
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonList,
    IonItem,
    IonInput,
    IonButton,
    IonText,
    IonSpinner,
  ],
})
export class EncryptionUnlockPage {
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly recoveryKey = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** Unlock this device from the entered recovery key. */
  unlock(): void {
    const key = this.recoveryKey().trim();
    if (!key) {
      return;
    }
    this.withBusy(this.crypto.recoverWithKey(key)).subscribe(() => {
      void this.router.navigateByUrl('/rooms', { replaceUrl: true });
    });
  }

  /** Wrap a one-shot action with shared busy/error handling (mirrors LoginPage). */
  private withBusy<T>(source: Observable<T>): Observable<T> {
    this.busy.set(true);
    this.error.set(null);
    return source.pipe(
      takeUntilDestroyed(this.destroyRef),
      catchError((err) => {
        this.error.set(err instanceof Error ? err.message : String(err));
        return EMPTY;
      }),
      finalize(() => this.busy.set(false)),
    );
  }
}
