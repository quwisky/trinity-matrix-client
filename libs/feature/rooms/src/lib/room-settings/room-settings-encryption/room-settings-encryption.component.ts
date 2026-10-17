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
  RoomEncryptionService,
} from '@trinity/data-access/room-administration';
import {
  concat,
  defer,
  filter,
  ignoreElements,
  switchMap,
  tap,
  timer,
} from 'rxjs';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { settingsActionFailure } from '../settings-action-failure';

const WARNING =
  "This can't be undone. New messages will be end-to-end encrypted; earlier messages stay as they are. Bridges, bots and some older apps may stop working here.";
const PUBLIC_WARNING =
  'Anyone can join this room, so encryption adds little privacy and can make joining slower.';
const LATE =
  "Encryption is on, but this device hasn't caught up yet. Messages you send from here may not be encrypted.";
const BUSY = 'Turning on encryption…';
/** How long sync may take to deliver the accepted event before the user is warned. */
const SYNC_WAIT_MS = 15_000;

/**
 * `waiting`: the server took the event and sync has not delivered it. `late`: it has not
 * arrived within {@link SYNC_WAIT_MS}, so the SDK may still send unencrypted from here.
 */
type Phase = 'idle' | 'sending' | 'waiting' | 'late';

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
  /** The phase as the user sees it: sync delivering the event ends any request. */
  readonly view = computed<Phase | 'done'>(() => {
    const phase = this.phase();
    return phase !== 'idle' && this.encrypted() === true ? 'done' : phase;
  });
  readonly busy = computed(
    () => this.view() === 'sending' || this.view() === 'waiting',
  );
  readonly late = computed(() => this.view() === 'late');
  readonly buttonLabel = computed(() =>
    this.busy() ? BUSY : 'Turn on encryption…',
  );
  readonly lateWarning = LATE;
  /** Text for the one persistent live region, so each change is announced. */
  readonly announcement = computed(() => {
    switch (this.view()) {
      case 'sending':
      case 'waiting':
        return BUSY;
      case 'late':
        return LATE;
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
    // The button that held focus is replaced by the outcome; focus follows it there.
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
        closeWhen: this.withdrawn$,
      })
      .pipe(
        filter(Boolean),
        filter(() => this.phase() === 'idle'),
        tap(() => {
          this.errorState.set(null);
          this.phase.set('sending');
        }),
        switchMap(() =>
          concat(
            this.encryption
              .turnOn({ accountId, roomId })
              .pipe(
                ignoreElements(),
                tap({ error: () => this.phase.set('idle') }),
              ),
            defer(() => {
              this.phase.set('waiting');
              return timer(SYNC_WAIT_MS);
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          if (this.view() === 'waiting') this.phase.set('late');
        },
        error: (error: unknown) =>
          this.errorState.set(
            settingsActionFailure(
              error,
              "Couldn't turn on encryption. Try again.",
            ),
          ),
      });
  }
}
