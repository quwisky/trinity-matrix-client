import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  JoinRule,
  RoomAdministrationError,
  RoomEncryptionService,
} from '@trinity/data-access/room-administration';
import { filter, of, switchMap, tap } from 'rxjs';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { settingsActionFailure } from '../settings-action-failure';

const WARNING =
  "This can't be undone. New messages will be end-to-end encrypted; earlier messages stay as they are. Bridges, bots and some older apps may stop working here.";
const PUBLIC_WARNING =
  'Anyone can join this room, so encryption adds little privacy and can make joining slower.';
const LATE_STATUS =
  'Encryption is on for this room, but not yet on this device.';
const LATE =
  "This device couldn't apply it, so messages you send from here may not be encrypted.";
const BUSY = 'Turning on encryption…';

/**
 * `done`: the server took the event and this device encrypts there. `late`: the server has
 * it but this device could not apply it, so the SDK may still send unencrypted from here;
 * Turn on then retries applying it here, without asking again.
 */
type Phase = 'idle' | 'sending' | 'done' | 'late';

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
  private readonly phase = signal<Phase>('idle');
  private readonly errorState = signal<string | null>(null);
  private readonly statusLine =
    viewChild<ElementRef<HTMLElement>>('statusLine');
  private readonly lateLine = viewChild<ElementRef<HTMLElement>>('lateLine');

  readonly errorId = 'room-settings-encryption-error';
  readonly error = this.errorState.asReadonly();
  /** Sync may never deliver the event this device sent, so its own confirmed apply counts. */
  readonly encrypted = computed(() =>
    this.phase() === 'done' ? true : (this.draft.snapshot()?.encrypted ?? null),
  );
  readonly permission = computed(
    () => this.draft.snapshot()?.permissions.encryption ?? null,
  );
  readonly status = computed(() => {
    if (this.late()) return LATE_STATUS;
    const encrypted = this.encrypted();
    if (encrypted === null) return 'Encryption status is unavailable.';
    return encrypted
      ? "Messages in this room are end-to-end encrypted. This can't be turned off."
      : 'Messages in this room are not end-to-end encrypted.';
  });
  readonly offered = computed(() => this.encrypted() === false);
  /** The phase as the user sees it: sync delivering the event ends any request. */
  readonly view = computed<Phase>(() => {
    const phase = this.phase();
    return phase !== 'idle' && this.encrypted() === true ? 'done' : phase;
  });
  readonly busy = computed(() => this.view() === 'sending');
  readonly late = computed(() => this.view() === 'late');
  readonly buttonLabel = computed(() =>
    this.busy()
      ? BUSY
      : this.late()
        ? 'Try again on this device'
        : 'Turn on encryption…',
  );
  readonly lateWarning = LATE;
  /** Text for the one persistent live region, so each change is announced. */
  readonly announcement = computed(() => {
    switch (this.view()) {
      case 'sending':
        return BUSY;
      case 'late':
        return `${LATE_STATUS} ${LATE}`;
      case 'done':
        return 'Encryption is on.';
      default:
        return this.error() ?? '';
    }
  });
  private readonly withdrawn$ = toObservable(this.offered).pipe(
    filter((offered) => !offered),
  );

  constructor() {
    // When the outcome replaces the button that held focus, focus follows it there.
    afterRenderEffect(() => {
      const view = this.view();
      if (view !== 'done' && view !== 'late') return;
      const target = view === 'done' ? this.statusLine() : this.lateLine();
      const active = target?.nativeElement.ownerDocument.activeElement;
      if (!active || active === active.ownerDocument.body) {
        target?.nativeElement.focus();
      }
    });
  }

  turnOn(): void {
    const snapshot = this.draft.snapshot();
    const from = this.phase();
    if (!snapshot || (from !== 'idle' && from !== 'late')) return;
    const { accountId, roomId } = snapshot.target;
    const message =
      snapshot.access.joinRule === JoinRule.Public
        ? `${WARNING}\n\n${PUBLIC_WARNING}`
        : WARNING;
    // The room is already encrypted on the server, so a retry has nothing left to confirm.
    const confirmed$ =
      from === 'late'
        ? of(true)
        : this.alert.confirm$({
            header: 'Turn on encryption?',
            message,
            confirmText: 'Turn on encryption',
            variant: 'danger',
            closeWhen: this.withdrawn$,
          });
    confirmed$
      .pipe(
        filter(Boolean),
        filter(() => this.phase() === from),
        tap(() => {
          this.errorState.set(null);
          this.phase.set('sending');
        }),
        switchMap(() =>
          this.encryption
            .turnOn({ accountId, roomId })
            .pipe(tap({ complete: () => this.phase.set('done') })),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: (error: unknown) => {
          const partial =
            error instanceof RoomAdministrationError &&
            error.outcome.failure === 'partial-update';
          this.phase.set(partial ? 'late' : from);
          if (partial) return;
          this.errorState.set(
            settingsActionFailure(
              error,
              "Couldn't turn on encryption. Try again.",
            ),
          );
        },
      });
  }
}
