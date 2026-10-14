import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, FormRoot } from '@angular/forms/signals';
import {
  TrnButton,
  TrnFieldImports,
  TrnInput,
} from '@trinity/components/controls';
import { AppLockService } from '@trinity/data-access/app-lock';
import { HostLockIntegrationService } from '@trinity/runtime/host';
import { shownError } from '@trinity/util/ui';
import { EMPTY, Observable, type Subscription, take } from 'rxjs';
import { AppLockLifecycleBinding } from '../../composition/app-lock-lifecycle.binding';
import { AppLockCoverState } from './app-lock-cover.state';

export { unlockLabel, useMethodLabel } from './app-lock-cover.copy';

/**
 * App lock's cover (spec §2): a modal `<dialog>` in the top layer, above every overlay, that
 * makes the rest of the app inert until the person unlocks. It shows only the app's mark, its
 * name and the unlock control; nothing about accounts or rooms. It stays mounted for the app's
 * lifetime and is open exactly while App lock is `locked`. This component owns the dialog,
 * the shell signals and focus; {@link AppLockCoverState} owns what it shows and does.
 */
@Component({
  selector: 'trn-app-lock-cover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-cover.component.html',
  imports: [FormField, FormRoot, TrnButton, TrnFieldImports, TrnInput],
  providers: [AppLockCoverState],
})
export class AppLockCoverComponent {
  private readonly appLock = inject(AppLockService);
  private readonly lockIntegration = inject(HostLockIntegrationService);
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private mounted = false;
  private painted: Subscription | null = null;

  protected readonly state = inject(AppLockCoverState);
  protected readonly shownError = shownError;

  constructor() {
    // Open exactly while locked, after the view exists, so it is in the first painted frame.
    afterRenderEffect(() => {
      const locked = this.appLock.locked();
      untracked(() => {
        const firstRender = !this.mounted;
        this.mounted = true;
        if (locked) this.open(firstRender);
        else this.close();
      });
    });
    // A new view, or an answer that disabled the control, puts focus on its first control.
    afterRenderEffect(() => {
      this.state.view();
      this.state.focusRequest();
      untracked(() => this.focusPrimary());
    });
    // The binding tells of a return after its away timer, so a lock due on return is in place.
    inject(AppLockLifecycleBinding)
      .visits.pipe(takeUntilDestroyed())
      .subscribe((visit) => {
        if (visit === 'away') this.state.left();
        else if (this.appLock.locked()) this.state.visit(true);
      });
    inject(DestroyRef).onDestroy(() => this.painted?.unsubscribe());
  }

  /** Escape asks the dialog to close; it never may while locked. */
  protected onKeydown(event: KeyboardEvent): void {
    // Keys typed in the cover never reach the page's document-level shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') event.preventDefault();
  }

  /**
   * Whatever closed the dialog while locked (a second Escape, Android's back, dev tools), it
   * reopens where it was.
   */
  protected onClose(): void {
    const dialog = this.dialog().nativeElement;
    if (!this.appLock.locked() || dialog.open) return;
    dialog.showModal();
    this.focusPrimary();
  }

  /**
   * On a cold start or reload the system prompt opens by itself; a later lock (Lock now, the
   * away timer) waits for the app to come back to the front.
   */
  private open(firstRender: boolean): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) dialog.showModal();
    this.state.opened();
    this.focusPrimary();
    // Two frames: the first lays the cover out, the second has painted it. The shell keeps a
    // window it hid transparent until it hears this (a reloaded renderer included).
    this.painted?.unsubscribe();
    this.painted = this.afterPaint().subscribe(() => {
      this.painted = null;
      this.lockIntegration.coverPainted().pipe(take(1)).subscribe();
    });
    this.state.visit(firstRender);
  }

  private close(): void {
    this.painted?.unsubscribe();
    this.painted = null;
    const dialog = this.dialog().nativeElement;
    if (dialog.open) dialog.close();
    this.state.closed();
  }

  /** The view's first control, or its first enabled one while that is disabled (a wait). */
  private focusPrimary(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) return;
    const primary = dialog.querySelector<HTMLElement>('[data-autofocus]');
    if (primary && !primary.matches(':disabled')) {
      primary.focus();
      return;
    }
    dialog
      .querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')
      ?.focus();
  }

  private afterPaint(): Observable<void> {
    const view = this.window;
    if (!view) return EMPTY;
    return new Observable<void>((subscriber) => {
      let frame = view.requestAnimationFrame(() => {
        frame = view.requestAnimationFrame(() => {
          subscriber.next();
          subscriber.complete();
        });
      });
      return () => view.cancelAnimationFrame(frame);
    });
  }
}
