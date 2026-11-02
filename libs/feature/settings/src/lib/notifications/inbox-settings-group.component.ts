import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton, TrnSwitchComponent } from '@trinity/components/controls';
import {
  TrnAlertService,
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnToastService,
  type ConfirmOptions,
} from '@trinity/components/overlay';
import {
  MentionIndexService,
  MentionInboxPreferences,
} from '@trinity/data-access/notifications';
import type { PreferenceCommandOutcome } from '@trinity/runtime/preferences';
import {
  EMPTY,
  catchError,
  finalize,
  map,
  of,
  switchMap,
  tap,
  timeout,
  type Observable,
} from 'rxjs';

/** The service puts no limit on a count, and the question shouldn't wait long for its number. */
const COUNT_READ_MS = 1_000;

function recordQuestion(count: number | null): ConfirmOptions {
  const record =
    count === null
      ? 'mentions'
      : count === 1
        ? '1 mention'
        : `${count.toLocaleString('en')} mentions`;
  return {
    header: "Delete this device's mention history?",
    message: `Trinity will delete its record of ${record} on this device. You can't get it back. Older mentions in encrypted rooms, and those from rooms set to mentions only, won't appear in the inbox again. Your messages themselves aren't deleted.`,
    confirmText: 'Delete and turn off',
    cancelText: 'Cancel',
    variant: 'danger',
  };
}

type SaveSwitch = (on: boolean) => Observable<PreferenceCommandOutcome>;

/**
 * Settings › Notifications › Inbox: this device's two inbox switches. Turning either off stops
 * recording and deletes the record for every account, asking first when it holds any mentions.
 */
@Component({
  selector: 'trn-inbox-settings-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inbox-settings-group.component.html',
  imports: [
    TrnButton,
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
    TrnSwitchComponent,
  ],
})
export class InboxSettingsGroupComponent {
  private readonly preferences = inject(MentionInboxPreferences);
  private readonly index = inject(MentionIndexService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly failure =
    viewChild<ElementRef<HTMLElement>>('deleteFailure');

  readonly showInbox = this.preferences.showInbox;
  /** The stored choice, left alone while the inbox is off so it comes back with the inbox. */
  readonly keepRecord = this.preferences.keepRecord;
  readonly deleteFailed = this.index.deleteFailed;
  readonly unknown = computed(() => !this.preferences.bothRead());
  /** A change is under way. The controls stay focusable, and decline further changes. */
  readonly busy = signal(false);

  constructor() {
    // The group ends a long page, so the error can land below the fold.
    effect(() =>
      this.failure()?.nativeElement.scrollIntoView({ block: 'nearest' }),
    );
  }

  setShowInbox(on: boolean): void {
    this.change(
      on,
      (value) => this.preferences.setShowInbox(value),
      this.keepRecord(),
    );
  }

  setKeepRecord(on: boolean): void {
    this.change(on, (value) => this.preferences.setKeepRecord(value), true);
  }

  retryDelete(): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.deleteRecord()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.busy.set(false);
        if (!this.deleteFailed()) {
          // The button that held focus has gone.
          afterNextRender(
            () => document.getElementById('notif-show-inbox-switch')?.focus(),
            { injector: this.injector },
          );
        }
      });
  }

  private change(on: boolean, save: SaveSwitch, willRecord: boolean): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    (on ? this.turnOn(save, willRecord) : this.turnOff(save))
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe();
  }

  /** Recording must never start beside a record that was meant to be gone. */
  private turnOn(save: SaveSwitch, willRecord: boolean): Observable<unknown> {
    const retry = willRecord && this.deleteFailed();
    return (retry ? this.deleteRecord() : of(undefined)).pipe(
      switchMap(() =>
        retry && this.deleteFailed() ? EMPTY : this.save(save, true),
      ),
      takeUntilDestroyed(this.destroyRef),
    );
  }

  private turnOff(save: SaveSwitch): Observable<unknown> {
    return this.index.count().pipe(
      timeout(COUNT_READ_MS),
      catchError(() => of(null)),
      switchMap((count) =>
        count === 0 ? of(true) : this.alert.confirm$(recordQuestion(count)),
      ),
      takeUntilDestroyed(this.destroyRef),
      // Past here the person has decided, and leaving the page mustn't abandon it.
      switchMap((confirmed) => (confirmed ? this.save(save, false) : EMPTY)),
      switchMap((saved) => (saved ? this.deleteRecord() : EMPTY)),
    );
  }

  private save(save: SaveSwitch, on: boolean): Observable<boolean> {
    return save(on).pipe(
      map((outcome) => outcome.kind === 'completed'),
      catchError(() => of(false)),
      tap((saved) => {
        if (!saved) {
          this.toast.show('Couldn’t save this setting. Try again.', {
            duration: 4000,
            variant: 'danger',
          });
        }
      }),
    );
  }

  /** A failure reads from `deleteFailed`, which also covers the delete retried at start. */
  private deleteRecord(): Observable<unknown> {
    return this.index.deleteAll().pipe(catchError(() => of(undefined)));
  }
}
