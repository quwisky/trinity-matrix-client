import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  disabled,
  form,
  maxLength,
  pattern,
  required,
  submit,
} from '@angular/forms/signals';
import {
  TrnButton,
  TrnFieldImports,
  TrnInput,
} from '@trinity/components/controls';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  APP_LOCK_CLOCK,
  AppLockService,
  PIN_MAX_LENGTH,
  PIN_PATTERN,
  formatRetryWait,
  type UnlockOutcome,
} from '@trinity/data-access/app-lock';
import {
  AppRestartService,
  getTrinityDesktopBridge,
} from '@trinity/platform-native';
import {
  HostLifecycleService,
  HostLockIntegrationService,
  HostSystemUiService,
  type HostPresenceBiometry,
} from '@trinity/runtime/host';
import { shownError } from '@trinity/util/ui';
import {
  EMPTY,
  Observable,
  type Subscription,
  defaultIfEmpty,
  fromEvent,
  map,
  merge,
  take,
} from 'rxjs';
import {
  fallbackLine,
  resetFailure,
  unlockLabel,
  useMethodLabel,
} from './app-lock-cover.copy';

export { unlockLabel, useMethodLabel } from './app-lock-cover.copy';

/**
 * What the cover shows under its heading:
 * - `system`: the system prompt is primary, with "Use PIN instead";
 * - `pin`: the PIN form, with "Forgot PIN?";
 * - `pin-unreadable`: the PIN store can't be read now: Retry, the system prompt if any, the reset;
 * - `no-pin`: the store works but holds no PIN (a reset that stopped half way);
 * - `no-pin-store`: this host keeps no PIN (a desktop without usable encryption);
 * - `forgot`: a forgotten PIN where the system prompt can still unlock;
 * - `erase`: the "Erase all data on this device" confirmation.
 */
type CoverView =
  | 'system'
  | 'pin'
  | 'pin-unreadable'
  | 'no-pin'
  | 'no-pin-store'
  | 'forgot'
  | 'erase';

interface PinModel {
  pin: string;
}

/**
 * App lock's cover (spec §2): a modal `<dialog>` in the top layer, above every overlay, that
 * makes the rest of the app inert until the person unlocks. It shows only the app's mark, its
 * name and the unlock control; nothing about accounts or rooms. It stays mounted for the app's
 * lifetime and is open exactly while App lock is `locked`. It never logs, shows or keeps a
 * PIN after a submit.
 */
@Component({
  selector: 'trn-app-lock-cover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-cover.component.html',
  imports: [FormField, FormRoot, TrnButton, TrnFieldImports, TrnInput],
})
export class AppLockCoverComponent {
  private readonly appLock = inject(AppLockService);
  private readonly lockIntegration = inject(HostLockIntegrationService);
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly systemUi = inject(HostSystemUiService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly appRestart = inject(AppRestartService);
  private readonly clock = inject(APP_LOCK_CLOCK);
  private readonly destroyRef = inject(DestroyRef);
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly model = signal<PinModel>({ pin: '' });
  private readonly now = signal(this.clock());
  private readonly panel = signal<'main' | 'forgot' | 'erase'>('main');
  private readonly choosePin = signal(false);
  /** The wait the last PIN answer started; the host's `nextAttemptAt` also counts. */
  private readonly answeredPinWait = signal<number | null>(null);
  private readonly message = signal<string | null>(null);
  private readonly biometry = computed(() => {
    const system = this.appLock.support().system;
    return system.kind === 'available' ? system.biometry : null;
  });
  /**
   * The method the cover last saw, to name it once it has gone ("Face ID isn’t available").
   * Lazy like every signal: it remembers only what was read while offered (see `unlockText`).
   */
  private readonly knownBiometry = linkedSignal<
    HostPresenceBiometry | null,
    HostPresenceBiometry | null
  >({
    source: this.biometry,
    computation: (biometry, previous) => biometry ?? previous?.value ?? null,
  });
  private readonly pinWaitUntil = computed(() => {
    const pin = this.appLock.support().pin;
    const hosted = pin.kind === 'available' ? pin.nextAttemptAt : null;
    const answered = this.answeredPinWait();
    if (hosted === null) return answered;
    return answered === null ? hosted : Math.max(hosted, answered);
  });
  private mounted = false;
  private promptedThisVisit = false;
  private painted: Subscription | null = null;
  private refreshing: Subscription | null = null;

  protected readonly appName = this.appLock.appName;
  protected readonly shownError = shownError;
  protected readonly busy = signal(false);
  protected readonly erasing = signal(false);
  /** The polite live region: set once per event, never by the countdown's ticks. */
  protected readonly announcement = signal('');
  protected readonly systemAvailable = this.appLock.systemAvailable;
  protected readonly view = computed((): CoverView => {
    const panel = this.panel();
    if (panel === 'erase') return 'erase';
    if (panel === 'forgot') return this.systemAvailable() ? 'forgot' : 'erase';
    if (this.systemAvailable() && !this.choosePin()) return 'system';
    const pin = this.appLock.pinState();
    switch (pin) {
      case 'ready':
        return 'pin';
      case 'unreadable':
        return 'pin-unreadable';
      case 'not-set':
        return 'no-pin';
      case 'not-supported':
        return 'no-pin-store';
      default: {
        const unhandled: never = pin;
        void unhandled;
        return 'no-pin-store';
      }
    }
  });
  /** "Use PIN instead" leads somewhere useful: a PIN form, or the unreadable-PIN Retry. */
  protected readonly pinOffered = computed(() => {
    const pin = this.appLock.pinState();
    return pin === 'ready' || pin === 'unreadable';
  });
  // Both read the method through `knownBiometry`, which keeps it current while it is offered.
  protected readonly unlockText = computed(() => {
    const biometry = this.systemAvailable() ? this.knownBiometry() : null;
    return biometry ? unlockLabel(biometry) : 'Unlock';
  });
  protected readonly backText = computed(() => {
    const biometry = this.systemAvailable() ? this.knownBiometry() : null;
    return biometry ? useMethodLabel(biometry) : null;
  });
  protected readonly waitUntil = computed(() => {
    switch (this.view()) {
      case 'pin':
        return this.pinWaitUntil();
      case 'system':
        return this.appLock.systemWaitUntil();
      default:
        return null;
    }
  });
  protected readonly waiting = computed(() => {
    const until = this.waitUntil();
    return until !== null && until > this.now();
  });
  /** `max(0, until - now)`, so a wait already over never reads as a negative countdown. */
  protected readonly waitText = computed(() => {
    const until = this.waitUntil();
    return this.waiting() && until !== null
      ? `Try again in ${formatRetryWait(Math.max(0, until - this.now()))}.`
      : null;
  });
  /** The method or reason line (`app-lock-message`), also the dialog's description. */
  protected readonly line = computed(() => {
    const message = this.message();
    const wait = this.waitText();
    if (message !== null || wait !== null) {
      return [message, wait].filter((part) => part !== null).join(' ');
    }
    return this.reasonLine() ?? '';
  });
  protected readonly recoveryText = computed(() => {
    const name = this.appName;
    const opening =
      this.view() === 'no-pin'
        ? `${name} has no PIN on this device`
        : `${name} can’t check a PIN on this device`;
    return this.systemAvailable()
      ? `${opening}.`
      : `${opening}, so it can’t unlock. The only way back in is to erase all data on this device.`;
  });
  protected readonly eraseText = computed(() =>
    this.panel() === 'forgot'
      ? `If you’ve forgotten your PIN, the only way back into ${this.appName} is to erase all data on this device. That signs out every account. Encrypted messages are lost unless you have your recovery key or another signed-in device.`
      : 'Erasing all data on this device signs out every account. Encrypted messages are lost unless you have your recovery key or another signed-in device.',
  );
  protected readonly pinForm = form(this.model, (path) => {
    required(path.pin, { message: `Enter your ${this.appName} PIN.` });
    pattern(path.pin, PIN_PATTERN, { message: 'Enter 4 to 16 digits.' });
    // Also the field's `maxlength`: Signal Forms owns that attribute.
    maxLength(path.pin, PIN_MAX_LENGTH, { message: 'Enter 4 to 16 digits.' });
    disabled(path.pin, { when: () => this.busy() || this.waiting() });
  });

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
    // Each new view moves focus to its first control.
    afterRenderEffect(() => {
      this.view();
      untracked(() => this.focusPrimary());
    });
    // The countdown ticks only during a wait. The live region hears its start (see `say`)
    // and its end, whether the clock passed it or the service cleared the system wait.
    let endsAt: number | null = null;
    effect((onCleanup) => {
      if (this.waiting()) {
        endsAt = untracked(this.waitUntil);
        const tick = setInterval(() => this.now.set(this.clock()), 1_000);
        onCleanup(() => clearInterval(tick));
        return;
      }
      const ended = endsAt;
      endsAt = null;
      if (ended !== null && this.clock() >= ended) {
        untracked(() => this.waitEnded());
      }
    });
    this.visits()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((visit) => {
        if (visit === 'away') {
          // Trinity's own system prompt sends the app to the background; that isn't leaving.
          if (!this.systemUi.active()) this.promptedThisVisit = false;
        } else if (this.appLock.locked()) {
          this.visit(true);
        }
      });
    this.destroyRef.onDestroy(() => {
      this.painted?.unsubscribe();
      this.refreshing?.unsubscribe();
    });
  }

  protected unlockWithSystem(): void {
    if (this.busy()) return;
    this.say(null);
    this.busy.set(true);
    this.appLock
      .unlockWithSystem()
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        this.busy.set(false);
        this.present(outcome, 'system');
      });
  }

  protected usePin(): void {
    this.say(null);
    this.choosePin.set(true);
  }

  protected useSystem(): void {
    this.say(null);
    this.panel.set('main');
    this.choosePin.set(false);
  }

  protected submitPin(): void {
    if (this.busy() || this.waiting()) return;
    void submit(this.pinForm, async () => {
      const pin = this.model().pin;
      // The PIN leaves the form at once; nothing here keeps it after this call.
      this.pinForm().reset({ pin: '' });
      this.say(null);
      this.busy.set(true);
      this.appLock
        .unlockWithPin(pin)
        .pipe(take(1), takeUntilDestroyed(this.destroyRef))
        .subscribe((outcome) => {
          this.busy.set(false);
          this.present(outcome, 'pin');
        });
    });
  }

  protected retry(): void {
    if (this.busy()) return;
    this.say(null);
    this.busy.set(true);
    this.appLock
      .retry()
      .pipe(
        take(1),
        defaultIfEmpty(undefined),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.busy.set(false);
        this.now.set(this.clock());
        if (this.appLock.locked() && this.view() === 'pin-unreadable') {
          this.say(
            `${this.appName} still can’t read your PIN. Try again later.`,
          );
        }
      });
  }

  protected showForgot(): void {
    this.say(null);
    this.panel.set('forgot');
  }

  protected confirmErase(): void {
    this.say(null);
    this.panel.set('erase');
  }

  /** Cancel from "Forgot PIN?" or the erase confirmation: back to the unlock control. */
  protected cancelPanel(): void {
    this.say(null);
    this.panel.set('main');
  }

  protected erase(): void {
    if (this.erasing()) return;
    this.erasing.set(true);
    this.say(null);
    this.accounts
      .resetInstallation()
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        const failure = resetFailure(outcome, this.appName);
        if (failure === null) {
          // Stays erasing: the app is about to be replaced, and a second press would race it.
          this.appRestart.restart();
          return;
        }
        this.erasing.set(false);
        this.say(failure);
        // A reset that stopped part way may have taken the PIN: show what is left honestly.
        this.visit(false);
      });
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

  private reasonLine(): string | null {
    const system = this.appLock.support().system;
    if (this.view() !== 'pin' || system.kind === 'available') return null;
    const line = fallbackLine(system.reason, this.knownBiometry());
    return line === null ? null : `${line} Enter your ${this.appName} PIN.`;
  }

  private present(outcome: UnlockOutcome, via: 'system' | 'pin'): void {
    this.now.set(this.clock());
    switch (outcome.kind) {
      case 'unlocked':
        // The lock's own state closes the cover and resets it.
        this.answeredPinWait.set(null);
        this.say(null);
        return;
      case 'cancelled':
        return;
      case 'failed':
        if (via === 'pin') this.answeredPinWait.set(outcome.until);
        this.say(via === 'pin' ? 'That PIN isn’t right.' : 'That didn’t work.');
        return;
      case 'delayed':
        if (via === 'pin') this.answeredPinWait.set(outcome.until);
        this.say(null);
        return;
      case 'use-pin': {
        const line =
          fallbackLine(outcome.reason, this.knownBiometry()) ??
          'Your device’s unlock isn’t available.';
        this.choosePin.set(true);
        this.say(
          this.appLock.pinState() === 'ready'
            ? `${line} Enter your ${this.appName} PIN.`
            : line,
        );
        return;
      }
      case 'invalid':
        this.say('Enter 4 to 16 digits.');
        return;
      case 'unavailable':
        this.say(`${this.appName} can’t read your PIN right now. Try again.`);
        this.visit(false);
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
      }
    }
  }

  /** Sets the visible line and announces it once, with any wait it started. */
  private say(text: string | null): void {
    this.message.set(text);
    const announced = [text, this.waitText()].filter((part) => part !== null);
    this.announcement.set(announced.join(' '));
  }

  private waitEnded(): void {
    if (!this.appLock.locked()) return;
    this.message.set(null);
    this.announcement.set(
      this.view() === 'pin'
        ? 'You can try your PIN again.'
        : 'You can try again.',
    );
  }

  /**
   * The locked app is on screen: read the host's support again (decision 23), so a changed
   * biometry or a newly available system prompt shows. `prompt` opens the system prompt once
   * per visit: on a cold start or reload, and when the locked app comes back to the front;
   * never right after the person locked it in front of them.
   */
  private visit(prompt: boolean): void {
    this.refreshing?.unsubscribe();
    this.refreshing = this.appLock
      .refreshSupport()
      .pipe(take(1))
      .subscribe(() => {
        this.now.set(this.clock());
        if (prompt) this.autoPrompt();
      });
  }

  private autoPrompt(): void {
    if (
      !this.appLock.locked() ||
      this.promptedThisVisit ||
      this.view() !== 'system' ||
      this.busy() ||
      this.waiting()
    ) {
      return;
    }
    this.promptedThisVisit = true;
    this.unlockWithSystem();
  }

  /** "front" when the app comes to the front; on desktop, window focus counts (spec §2). */
  private visits(): Observable<'front' | 'away'> {
    const lifecycle = this.lifecycle.events.pipe(
      map((event): 'front' | 'away' =>
        event.kind === 'active' ? 'front' : 'away',
      ),
    );
    const view = this.window;
    const focus =
      getTrinityDesktopBridge() && view
        ? merge(
            fromEvent(view, 'focus').pipe(map(() => 'front' as const)),
            fromEvent(view, 'blur').pipe(map(() => 'away' as const)),
          )
        : EMPTY;
    return merge(lifecycle, focus);
  }

  private open(firstRender: boolean): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) dialog.showModal();
    this.knownBiometry();
    this.panel.set('main');
    this.choosePin.set(false);
    this.say(null);
    this.focusPrimary();
    // Two frames: the first lays the cover out, the second has painted it. The shell keeps a
    // window it hid transparent until it hears this (a reloaded renderer included).
    this.painted?.unsubscribe();
    this.painted = this.afterPaint().subscribe(() => {
      this.painted = null;
      this.lockIntegration.coverPainted().pipe(take(1)).subscribe();
    });
    this.visit(firstRender);
  }

  private close(): void {
    this.painted?.unsubscribe();
    this.painted = null;
    const dialog = this.dialog().nativeElement;
    if (dialog.open) dialog.close();
    this.promptedThisVisit = false;
    this.panel.set('main');
    this.choosePin.set(false);
    this.answeredPinWait.set(null);
    this.erasing.set(false);
    this.pinForm().reset({ pin: '' });
    this.say(null);
  }

  private focusPrimary(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) return;
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
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
