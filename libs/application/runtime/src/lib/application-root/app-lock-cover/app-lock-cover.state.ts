import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  disabled,
  form,
  maxLength,
  pattern,
  required,
  submit,
} from '@angular/forms/signals';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  APP_LOCK_CLOCK,
  AppLockService,
  PIN_MAX_LENGTH,
  PIN_PATTERN,
  formatRetryWait,
  type UnlockOutcome,
} from '@trinity/data-access/app-lock';
import { AppRestartService } from '@trinity/platform-native';
import {
  HostSystemUiService,
  type HostPresenceBiometry,
} from '@trinity/runtime/host';
import { type Subscription, defaultIfEmpty, take } from 'rxjs';
import {
  fallbackLine,
  resetFailure,
  unlockLabel,
  useMethodLabel,
} from './app-lock-cover.copy';

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
export type CoverView =
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
 * The lock screen's unlock state, scoped to `trn-app-lock-cover`: which view shows,
 * the waits and lines, the commands, and the once-per-visit system prompt. The component owns
 * the dialog, the host signals and focus. Never logs, shows or keeps a PIN after a submit.
 */
@Injectable()
export class AppLockCoverState {
  private readonly appLock = inject(AppLockService);
  private readonly systemUi = inject(HostSystemUiService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly appRestart = inject(AppRestartService);
  private readonly clock = inject(APP_LOCK_CLOCK);
  private readonly destroyRef = inject(DestroyRef);
  private readonly model = signal<PinModel>({ pin: '' });
  private readonly now = signal(this.clock());
  private readonly panel = signal<'main' | 'forgot' | 'erase'>('main');
  private readonly choosePin = signal(false);
  /** The wait the last PIN answer started; the host's `nextAttemptAt` also counts. */
  private readonly answeredPinWait = signal<number | null>(null);
  private readonly message = signal<string | null>(null);
  /** The view whose own text already says the message: there it is announced, not shown. */
  private readonly messageShownBy = signal<CoverView | null>(null);
  private readonly focusRequests = signal(0);
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
  private promptedThisVisit = false;
  /** A support read that should open the prompt is waiting; a later read keeps that intent. */
  private promptPending = false;
  /**
   * The lifecycle binding last said the app is on screen. Assumed at start, like the host
   * does; a window that reloads hidden hears otherwise before it may prompt.
   */
  private onScreen = true;
  private refreshing: Subscription | null = null;

  readonly appName = this.appLock.appName;
  readonly busy = signal(false);
  readonly erasing = signal(false);
  /** The polite live region: set once per event, never by the countdown's ticks. */
  readonly announcement = signal('');
  readonly systemAvailable = this.appLock.systemAvailable;
  readonly view = computed((): CoverView => {
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
  /** Bumped when focus should go back to the view's first control (the view itself too). */
  readonly focusRequest = this.focusRequests.asReadonly();
  /** "Use PIN instead" leads somewhere useful: a PIN form, or the unreadable-PIN Retry. */
  readonly pinOffered = computed(() => {
    const pin = this.appLock.pinState();
    return pin === 'ready' || pin === 'unreadable';
  });
  // Both read the method through `knownBiometry`, which keeps it current while it is offered.
  readonly unlockText = computed(() => {
    const biometry = this.systemAvailable() ? this.knownBiometry() : null;
    return biometry ? unlockLabel(biometry) : 'Unlock';
  });
  readonly backText = computed(() => {
    const biometry = this.systemAvailable() ? this.knownBiometry() : null;
    return biometry ? useMethodLabel(biometry) : null;
  });
  readonly waitUntil = computed(() => {
    switch (this.view()) {
      case 'pin':
        return this.pinWaitUntil();
      case 'system':
        return this.appLock.systemWaitUntil();
      default:
        return null;
    }
  });
  readonly waiting = computed(() => {
    const until = this.waitUntil();
    return until !== null && until > this.now();
  });
  /** `max(0, until - now)`, so a wait already over never reads as a negative countdown. */
  readonly waitText = computed(() => {
    const until = this.waitUntil();
    return this.waiting() && until !== null
      ? `Try again in ${formatRetryWait(Math.max(0, until - this.now()))}.`
      : null;
  });
  /** The method or reason line (`app-lock-message`), also the dialog's description. */
  readonly line = computed(() => {
    const message =
      this.messageShownBy() === this.view() ? null : this.message();
    const wait = this.waitText();
    if (message !== null || wait !== null) {
      return [message, wait].filter((part) => part !== null).join(' ');
    }
    return this.reasonLine() ?? '';
  });
  readonly recoveryText = computed(() => {
    const name = this.appName;
    const opening =
      this.view() === 'no-pin'
        ? `${name} has no PIN on this device`
        : `${name} can’t check a PIN on this device`;
    return this.systemAvailable()
      ? `${opening}.`
      : `${opening}, so it can’t unlock. The only way back in is to erase all data on this device.`;
  });
  readonly eraseText = computed(() => {
    const text =
      this.panel() === 'forgot'
        ? `If you’ve forgotten your PIN, the only way back into ${this.appName} is to erase all data on this device. That signs out every account. Encrypted messages are lost unless you have your recovery key or another signed-in device.`
        : 'Erasing all data on this device signs out every account. Encrypted messages are lost unless you have your recovery key or another signed-in device.';
    // The remembered method: one that has gone since it was offered still loses its unlock.
    return this.knownBiometry() === 'windows-hello'
      ? `${text} Windows Hello unlock is turned off too. You can turn it on again in Settings › Security › App lock.`
      : text;
  });
  readonly pinForm = form(this.model, (path) => {
    required(path.pin, { message: `Enter your ${this.appName} PIN.` });
    pattern(path.pin, PIN_PATTERN, { message: 'Enter 4 to 16 digits.' });
    // Also the field's `maxlength`: Signal Forms owns that attribute.
    maxLength(path.pin, PIN_MAX_LENGTH, { message: 'Enter 4 to 16 digits.' });
    disabled(path.pin, { when: () => this.busy() || this.waiting() });
  });

  constructor() {
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
    this.destroyRef.onDestroy(() => this.refreshing?.unsubscribe());
  }

  unlockWithSystem(): void {
    if (this.busy()) return;
    // A prompt by hand counts as this visit's prompt; a read answering later won't reopen it.
    this.promptedThisVisit = true;
    this.promptPending = false;
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

  usePin(): void {
    this.say(null);
    this.choosePin.set(true);
  }

  useSystem(): void {
    this.say(null);
    this.clearPin();
    this.panel.set('main');
    this.choosePin.set(false);
  }

  submitPin(): void {
    if (this.busy() || this.waiting()) return;
    void submit(this.pinForm, async () => {
      const pin = this.model().pin;
      // The PIN leaves the form at once; nothing here keeps it after this call.
      this.clearPin();
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

  retry(): void {
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
          this.refocus();
        }
      });
  }

  showForgot(): void {
    this.say(null);
    this.clearPin();
    this.panel.set('forgot');
  }

  confirmErase(): void {
    this.say(null);
    this.panel.set('erase');
  }

  /** Cancel from "Forgot PIN?" or the erase confirmation: back to the unlock control. */
  cancelPanel(): void {
    this.say(null);
    this.panel.set('main');
  }

  erase(): void {
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

  /** The cover opened: start from the unlock control, and remember the method on offer. */
  opened(): void {
    this.knownBiometry();
    this.panel.set('main');
    this.choosePin.set(false);
    this.say(null);
  }

  /** The cover closed: nothing of this visit is kept. */
  closed(): void {
    this.refreshing?.unsubscribe();
    this.refreshing = null;
    this.promptPending = false;
    this.promptedThisVisit = false;
    this.panel.set('main');
    this.choosePin.set(false);
    this.answeredPinWait.set(null);
    this.erasing.set(false);
    this.clearPin();
    this.say(null);
  }

  /**
   * The app left the front (hidden, minimised or, on desktop, blurred). Trinity's own system
   * prompt sends it there; that isn't leaving. A prompt still waiting for the support read is
   * dropped: it opens on the return instead, never over a window nobody can see.
   */
  left(): void {
    if (this.systemUi.active()) return;
    this.onScreen = false;
    this.promptPending = false;
    this.promptedThisVisit = false;
  }

  /** The app is on screen again: shown, restored or focused. */
  returned(): void {
    this.onScreen = true;
  }

  /**
   * The locked app is on screen: read the host's support again, so a changed biometry or a
   * newly available system prompt shows. `prompt` opens the system prompt once per visit (a
   * cold start or reload, or the app coming back to the front); never right after the person
   * locked it in front of them. A later read never drops a pending prompt.
   */
  visit(prompt: boolean): void {
    this.promptPending ||= prompt;
    this.refreshing?.unsubscribe();
    this.refreshing = this.appLock
      .refreshSupport()
      .pipe(take(1))
      .subscribe(() => {
        const promptNow = this.promptPending;
        this.promptPending = false;
        this.now.set(this.clock());
        if (promptNow) this.autoPrompt();
      });
  }

  private autoPrompt(): void {
    if (
      !this.appLock.locked() ||
      !this.onScreen ||
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
        this.refocus();
        return;
      case 'failed':
        if (via === 'pin') this.answeredPinWait.set(outcome.until);
        this.say(via === 'pin' ? 'That PIN isn’t right.' : 'That didn’t work.');
        this.refocus();
        return;
      case 'delayed':
        if (via === 'pin') this.answeredPinWait.set(outcome.until);
        this.say(null);
        this.refocus();
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
        this.refocus();
        return;
      }
      case 'invalid':
        this.say('Enter 4 to 16 digits.');
        this.refocus();
        return;
      case 'unavailable':
        // The unreadable view says this sentence itself; the PIN form, if the store reads
        // again, needs the line.
        this.say(
          `${this.appName} can’t read your PIN right now. Try again.`,
          'pin-unreadable',
        );
        this.refocus();
        this.visit(false);
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
      }
    }
  }

  /**
   * Sets the visible line and announces it once, with any wait it started. `shownBy` names a
   * view whose own text already says it, so the line doesn't repeat it there.
   */
  private say(text: string | null, shownBy: CoverView | null = null): void {
    this.message.set(text);
    this.messageShownBy.set(shownBy);
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
    this.refocus();
  }

  /** The attempt's control was disabled, so the browser dropped focus; ask for it back. */
  private refocus(): void {
    this.focusRequests.update((count) => count + 1);
  }

  private clearPin(): void {
    this.pinForm().reset({ pin: '' });
  }
}
