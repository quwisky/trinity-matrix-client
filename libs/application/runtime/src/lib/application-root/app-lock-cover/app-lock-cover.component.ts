import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, FormRoot } from '@angular/forms/signals';
import { TitleBarState } from '@trinity/application/workspace';
import {
  TrnButton,
  TrnFieldImports,
  TrnInput,
  TrnPasswordInputComponent,
} from '@trinity/components/controls';
import { AppLockService } from '@trinity/data-access/app-lock';
import { HostLockIntegrationService } from '@trinity/runtime/host';
import { shownError } from '@trinity/util/ui';
import { EMPTY, type Subscription, take } from 'rxjs';
import { afterPaint } from '../../composition/after-paint';
import { AppLockDialogGate } from '../../composition/app-lock-dialog.gate';
import { AppLockLifecycleBinding } from '../../composition/app-lock-lifecycle.binding';
import { AppLockCoverState, type CoverView } from './app-lock-cover.state';

export { unlockLabel, useMethodLabel } from './app-lock-cover.copy';

/**
 * App lock's cover: a modal `<dialog>` in the top layer, above every overlay, that
 * makes the rest of the app inert until the person unlocks. It shows only the app's mark, its
 * name and the unlock control; nothing about accounts or rooms. It stays mounted for the app's
 * lifetime and is open exactly while App lock is `locked`. This component owns the dialog,
 * the shell signals and focus; {@link AppLockCoverState} owns what it shows and does.
 *
 * Its host moves to its own `<body>` child when it is created, before any render, so a modal
 * opened later is never moved (moving an open modal would take it out of the top layer). An
 * open CDK dialog marks every other `<body>` child `aria-hidden`, the root included; CDK skips
 * a child with `aria-live`, so the host carries `aria-live="off"` (no announcements of its own)
 * and the cover stays exposed to assistive technology over any CDK dialog, without touching
 * CDK's own record of what it hid. Mount it as a static child of the root, never inside a
 * control-flow block, which would re-insert the host where the block is.
 */
@Component({
  selector: 'trn-app-lock-cover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-cover.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnFieldImports,
    TrnInput,
    TrnPasswordInputComponent,
  ],
  providers: [AppLockCoverState],
  host: { 'aria-live': 'off' },
})
export class AppLockCoverComponent {
  private readonly appLock = inject(AppLockService);
  private readonly lockIntegration = inject(HostLockIntegrationService);
  private readonly document = inject(DOCUMENT);
  private readonly window = this.document.defaultView;
  private readonly injector = inject(Injector);
  private readonly dialogGate = inject(AppLockDialogGate);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private mounted = false;
  private painted: Subscription | null = null;

  protected readonly state = inject(AppLockCoverState);
  protected readonly shownError = shownError;
  protected readonly describedBy = computed(() =>
    coverDescription(this.state.view()),
  );
  /** A frameless desktop window keeps a drag strip where its title row was. */
  protected readonly titleRow = inject(TitleBarState).active;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    this.document.body.appendChild(host);
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
      const view = this.state.view();
      this.state.focusRequest();
      untracked(() => this.focusWhenShown(view));
    });
    // The binding tells of a return after its away timer, so a lock due on return is in place.
    inject(AppLockLifecycleBinding)
      .visits.pipe(takeUntilDestroyed())
      .subscribe((visit) => {
        if (visit === 'away') {
          this.state.left();
          return;
        }
        this.state.returned();
        if (this.appLock.locked()) this.state.visit(true);
      });
    inject(DestroyRef).onDestroy(() => {
      this.painted?.unsubscribe();
      host.remove();
    });
  }

  /** Escape asks the dialog to close; it never may while locked. */
  protected onKeydown(event: KeyboardEvent): void {
    // Keys typed in the cover never reach the page's document-level shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') event.preventDefault();
  }

  /**
   * Whatever closed the dialog while locked (a second Escape, dev tools), it reopens where it
   * was. Android's Back never closes it: the WebView's close request is a `cancel`, prevented
   * above, and the host's Back button sends the locked app to the background instead
   * (`TrinityHostNavigationAdapter`).
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
    this.dialogGate.coverShown(true);
    this.state.opened();
    this.focusPrimary();
    // The shell keeps a window it hid transparent until it hears the cover has painted (a
    // reloaded renderer included).
    this.painted?.unsubscribe();
    const painted = this.window ? afterPaint(this.window) : EMPTY;
    this.painted = painted.subscribe(() => {
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
    // After the native close has put focus back: a held dialog opens now and takes it.
    this.dialogGate.coverShown(false);
    this.state.closed();
  }

  /**
   * Focus once the dialog shows `view`. A view that changed while the cover opened (the prompt
   * at start fell back) is not in the DOM yet, so wait for the render that puts it there.
   */
  private focusWhenShown(view: string): void {
    if (this.dialog().nativeElement.dataset['view'] === view) {
      this.focusPrimary();
      return;
    }
    afterNextRender(() => this.focusPrimary(), { injector: this.injector });
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
}

/**
 * Ids of what explains `view` to a screen reader as the dialog gets focus. A view with no way to
 * unlock says why in its own paragraph, which the name alone ("Trinity is locked") doesn't.
 */
function coverDescription(view: CoverView): string {
  switch (view) {
    case 'pin-unreadable':
      return 'app-lock-unreadable-text app-lock-message';
    case 'no-pin':
    case 'no-pin-store':
      return 'app-lock-recovery-text app-lock-message';
    case 'forgot':
      return 'app-lock-forgot-text app-lock-message';
    case 'erase':
      return 'app-lock-erase-text app-lock-message';
    case 'system':
    case 'pin':
      return 'app-lock-message';
    default: {
      const unhandled: never = view;
      void unhandled;
      return 'app-lock-message';
    }
  }
}
