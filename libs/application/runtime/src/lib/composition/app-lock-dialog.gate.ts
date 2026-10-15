import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AppLockService } from '@trinity/data-access/app-lock';
import { Observable, defer, filter, map, of, take } from 'rxjs';
import { appLockCovers } from './app-lock.providers';

/**
 * Holds app-initiated dialogs while App lock covers the app (spec §2, "While locked"): a
 * dialog that an incoming event, a timer or a notification opens, rather than a person's
 * click, waits until the person has unlocked and the lock screen has closed. Opening only
 * after the lock screen's own close has put focus back lets the dialog take focus as it
 * opens, instead of opening behind the cover and losing focus to that restore.
 *
 * Effect-driven hosts read {@link clear}; one-shot openers wait on {@link whenClear}.
 * A person's click can't reach the app while it is locked, so click handlers need neither.
 */
@Injectable({ providedIn: 'root' })
export class AppLockDialogGate {
  private readonly appLock = inject(AppLockService);
  private readonly coverOpen = signal(false);
  private readonly isClear = computed(
    () => !appLockCovers(this.appLock.status()) && !this.coverOpen(),
  );
  private readonly clearChanges = toObservable(this.isClear);

  /** Nothing locks the app (or its state is known to be off) and the lock screen is closed. */
  readonly clear = this.isClear;

  /**
   * Emits once and completes as soon as a dialog may open: at once (synchronously) when it
   * already may. Cold.
   */
  whenClear(): Observable<void> {
    return defer(() =>
      untracked(this.clear)
        ? of(undefined)
        : this.clearChanges.pipe(
            filter(Boolean),
            take(1),
            map((): void => undefined),
          ),
    );
  }

  /** The lock screen reports whether its dialog is showing. */
  coverShown(shown: boolean): void {
    this.coverOpen.set(shown);
  }
}
