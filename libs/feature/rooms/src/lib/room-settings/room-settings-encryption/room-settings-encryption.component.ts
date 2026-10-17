import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  JoinRule,
  RoomActionPermissionError,
  RoomAdministrationError,
  RoomEncryptionService,
} from '@trinity/data-access/room-administration';
import { describeMatrixRequestFailure } from '@trinity/util/matrix';
import { filter, finalize, switchMap, tap } from 'rxjs';
import { RoomSettingsDraftService } from '../room-settings-draft.service';

const WARNING =
  "This can't be undone. New messages will be end-to-end encrypted; earlier messages stay as they are. Bridges, bots and some older apps may stop working here.";
const PUBLIC_WARNING =
  'Anyone can join this room, so encryption adds little privacy and can make joining slower.';

/** Room settings › General › Encryption: the room's status and the one-way Turn on. */
@Component({
  selector: 'trn-room-settings-encryption',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  templateUrl: './room-settings-encryption.component.html',
  styleUrl: './room-settings-encryption.component.scss',
})
export class RoomSettingsEncryptionComponent {
  private readonly draft = inject(RoomSettingsDraftService);
  private readonly encryption = inject(RoomEncryptionService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);
  /** `waiting`: the server took the event and sync has not delivered it yet. */
  private readonly phase = signal<'idle' | 'sending' | 'waiting'>('idle');
  private readonly errorState = signal<string | null>(null);

  readonly errorId = 'room-settings-encryption-error';
  readonly error = this.errorState.asReadonly();
  readonly encrypted = computed(() => this.draft.snapshot()?.encrypted ?? null);
  readonly permission = computed(
    () => this.draft.snapshot()?.permissions.encryption ?? null,
  );
  readonly status = computed(() => {
    const encrypted = this.encrypted();
    if (encrypted === null) return 'Encryption status is unavailable.';
    return encrypted
      ? "Messages in this room are end-to-end encrypted. This can't be turned off."
      : 'Messages in this room are not end-to-end encrypted.';
  });
  readonly offered = computed(() => this.encrypted() === false);
  readonly sending = computed(() => this.phase() === 'sending');
  readonly waiting = computed(() => this.phase() === 'waiting');

  turnOn(): void {
    const snapshot = this.draft.snapshot();
    if (!snapshot || this.phase() !== 'idle') return;
    const { accountId, roomId } = snapshot.target;
    const message =
      snapshot.access.joinRule === JoinRule.Public
        ? `${WARNING}\n\n${PUBLIC_WARNING}`
        : WARNING;
    this.alert
      .confirm$({
        header: 'Turn on encryption?',
        message,
        confirmText: 'Turn on encryption',
        variant: 'danger',
      })
      .pipe(
        filter(Boolean),
        tap(() => {
          this.errorState.set(null);
          this.phase.set('sending');
        }),
        switchMap(() =>
          this.encryption.turnOn({ accountId, roomId }).pipe(
            tap({ complete: () => this.phase.set('waiting') }),
            finalize(() => {
              if (this.phase() === 'sending') this.phase.set('idle');
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: (error: unknown) => this.errorState.set(failureMessage(error)),
      });
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof RoomActionPermissionError) {
    return error.message;
  }
  const cause =
    error instanceof RoomAdministrationError && error.cause !== undefined
      ? error.cause
      : error;
  return describeMatrixRequestFailure(
    cause,
    "Couldn't turn on encryption. Try again.",
  ).message;
}
