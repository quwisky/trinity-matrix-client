import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  TrnButton,
  TrnSelectComponent,
  TrnSwitchComponent,
  type TrnSelectOption,
} from '@trinity/components/controls';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';
import {
  AppLockService,
  type LockAfter,
  type NotificationText,
} from '@trinity/data-access/app-lock';
import {
  HostCapabilitiesService,
  HostScreenPrivacyService,
} from '@trinity/runtime/host';
import { Observable, catchError, defaultIfEmpty, of, take } from 'rxjs';
import { AppLockFlows, STOPPED, type AppLockFlowEnd } from './app-lock-flows';
import { AppLockNotificationTextComponent } from './app-lock-notification-text.component';
import {
  PIN_CHANGED,
  STORED_PIN_CLEARED,
  failureMessage,
  keyringNote,
  noPinNote,
  methodShortName,
  pinUnreadableNote,
  screenPrivacyNote,
  storedPinUnreadableNote,
  type AppLockChange,
} from './app-lock-group.copy';

/** Which App lock group to show; `hidden` where the host has no App lock (the web). */
type AppLockView = 'controls' | 'pin-unreadable' | 'keyring' | 'hidden';

/**
 * Settings › Security › App lock: the switch, Lock after, Notification text and Change PIN,
 * or why App lock can't be used here. Every change after setup needs a fresh verification,
 * and a control always shows the stored value, so nothing is left half-changed.
 */
@Component({
  selector: 'trn-app-lock-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-group.component.html',
  providers: [AppLockFlows],
  imports: [
    AppLockNotificationTextComponent,
    NgTemplateOutlet,
    TrnButton,
    TrnSelectComponent,
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
    TrnSwitchComponent,
  ],
})
export class AppLockGroupComponent {
  private readonly appLock = inject(AppLockService);
  private readonly flows = inject(AppLockFlows);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The host's negotiated operations; none until it answers or if it can't. */
  private readonly manifest = toSignal(
    inject(HostCapabilitiesService)
      .manifest()
      .pipe(catchError(() => of(null))),
    { initialValue: null },
  );
  /** What the host's app-switcher cover does; none until it answers or if it can't. */
  private readonly screenPrivacy = toSignal(
    inject(HostScreenPrivacyService)
      .support()
      .pipe(catchError(() => of(null))),
    { initialValue: null },
  );
  /** The web has no App lock. */
  private readonly hostHasAppLock = computed(
    () => this.manifest()?.operations['user-presence'].kind === 'supported',
  );

  protected readonly appName = this.appLock.appName;
  protected readonly groupDescription = `Hide ${this.appName} behind a lock screen on this device. Sync and notifications keep working while it’s locked.`;
  protected readonly keyringNote = keyringNote(this.appName);
  /** Clearing an unreadable PIN is allowed only over a readable "off". */
  protected readonly canClearPin = this.appLock.canClearUnreadablePin;
  protected readonly storedPinUnreadableNote = computed(() =>
    storedPinUnreadableNote(this.appName, this.canClearPin()),
  );
  protected readonly noPinNote = noPinNote(this.appName);
  /** What the app-switcher cover does, where the host has one. */
  protected readonly screenPrivacyNote = computed(() => {
    const cover = this.screenPrivacy();
    return this.manifest()?.operations['screen-privacy'].kind === 'supported' &&
      cover?.kind === 'supported'
      ? screenPrivacyNote(this.appName, cover.blocksCapture)
      : null;
  });
  protected readonly lockAfterOptions: readonly TrnSelectOption<LockAfter>[] = [
    {
      value: 'immediately',
      label: 'Immediately',
      testId: 'app-lock-after-immediately',
    },
    { value: '1m', label: 'After 1 minute', testId: 'app-lock-after-1m' },
    { value: '5m', label: 'After 5 minutes', testId: 'app-lock-after-5m' },
    { value: '15m', label: 'After 15 minutes', testId: 'app-lock-after-15m' },
    { value: '60m', label: 'After 1 hour', testId: 'app-lock-after-60m' },
  ];
  protected readonly enabled = this.appLock.enabled;
  protected readonly pinState = this.appLock.pinState;
  protected readonly busy = signal(false);
  /** Why the last change didn't happen; announced. */
  protected readonly error = signal<string | null>(null);
  /** A quiet confirmation for a change the controls can't show (a new PIN). */
  protected readonly status = signal('');
  /** What the select shows; a change that doesn't happen goes back to the stored value. */
  protected readonly shownLockAfter = linkedSignal(() =>
    this.appLock.lockAfter(),
  );
  /** Phones only offer "Hide on the lock screen". */
  protected readonly lockScreenTextOffered = this.appLock.lockScreenTextOffered;
  /** What the Notification text choice shows; like Lock after, back to the stored value. */
  protected readonly shownNotificationText = linkedSignal(() =>
    this.appLock.notificationText(),
  );
  protected readonly view = computed((): AppLockView => {
    if (this.enabled() || this.appLock.offered()) return 'controls';
    const pin = this.pinState();
    if (pin === 'unreadable') return 'pin-unreadable';
    return pin === 'not-supported' && this.hostHasAppLock()
      ? 'keyring'
      : 'hidden';
  });
  /** The system prompt in a sentence ("Face ID"), or null where the PIN is the only way. */
  protected readonly method = computed(() => {
    const system = this.appLock.support().system;
    return system.kind === 'available'
      ? methodShortName(system.biometry)
      : null;
  });
  protected readonly switchDescription = computed(() => {
    const method = this.method();
    const pin = this.enabled()
      ? `your ${this.appName} PIN`
      : `a ${this.appName} PIN you set now`;
    return method
      ? `Unlock with ${method}, or with ${pin}.`
      : `Unlock with ${pin}.`;
  });
  protected readonly pinDescription = computed(() => {
    const method = this.method();
    return method
      ? `Unlocks ${this.appName} when ${method} can’t.`
      : `Unlocks ${this.appName} on this device.`;
  });
  protected readonly pinUnreadableNote = computed(() =>
    pinUnreadableNote(this.appName, this.method()),
  );
  /**
   * Whether Change PIN can work: a PIN to check, or the system prompt, which can also replace
   * a PIN record the host can't read. Without either, the notes say what's left.
   */
  protected readonly canChangePin = computed(() => {
    const pin = this.pinState();
    return (
      pin === 'ready' ||
      (this.appLock.systemAvailable() &&
        (pin === 'not-set' || pin === 'unreadable'))
    );
  });
  /** On, with no PIN and no system prompt: nothing here can confirm a change. */
  protected readonly noPinToCheck = computed(
    () => this.pinState() === 'not-set' && !this.appLock.systemAvailable(),
  );
  protected readonly noScreenLock = computed(() => {
    const system = this.appLock.support().system;
    return (
      system.kind === 'unavailable' && system.reason === 'no-device-credential'
    );
  });

  constructor() {
    this.refresh();
    // One verification covers changes only while Settings stays open.
    this.destroyRef.onDestroy(() => this.appLock.endGuardWindow());
  }

  protected toggle(on: boolean): void {
    if (on === this.enabled() || this.busy()) return;
    if (on) this.run('enable', this.flows.turnOn());
    else
      this.run(
        'disable',
        this.flows.guarded(() => this.appLock.disable()),
      );
  }

  protected changeLockAfter(value: LockAfter | null): void {
    if (value === null || value === this.appLock.lockAfter() || this.busy()) {
      return;
    }
    this.shownLockAfter.set(value);
    this.run(
      'lock-after',
      this.flows.guarded(() => this.appLock.setLockAfter(value)),
    );
  }

  protected changeNotificationText(text: NotificationText): void {
    if (text === this.appLock.notificationText() || this.busy()) return;
    this.shownNotificationText.set(text);
    this.run(
      'notification-text',
      this.flows.guarded(() => this.appLock.setNotificationText(text)),
    );
  }

  protected changePin(): void {
    if (this.busy() || !this.canChangePin()) return;
    this.run('change-pin', this.flows.changePin());
  }

  /** App lock is readably off over a PIN record that can't be read: clear it. */
  protected clearStoredPin(): void {
    if (this.busy()) return;
    this.run('clear-pin', this.flows.clearUnreadablePin());
  }

  /** Re-read whether the stored PIN can be read (a keyring unlocked meanwhile). */
  protected retryPin(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.status.set('');
    this.busy.set(true);
    this.appLock
      .refreshSupport()
      .pipe(
        take(1),
        defaultIfEmpty(null),
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.busy.set(false);
        if (this.pinState() === 'unreadable') {
          this.status.set(`${this.appName} still can’t read the stored PIN.`);
        }
      });
  }

  private run(change: AppLockChange, flow: Observable<AppLockFlowEnd>): void {
    // The control is disabled while its dialogs are open, so the dialog can't hand focus back.
    const trigger = this.document.activeElement;
    this.error.set(null);
    this.status.set('');
    this.busy.set(true);
    flow
      .pipe(
        take(1),
        defaultIfEmpty(STOPPED),
        catchError(() =>
          // Commands never error; anything else reads as "not changed".
          of<AppLockFlowEnd>({
            kind: 'failed',
            reason: 'setting-not-saved',
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((end) => {
        this.busy.set(false);
        this.finish(change, end);
        this.restoreFocus(change, trigger);
      });
  }

  /**
   * Once the controls are enabled again, focus goes back to the control that started the
   * change, or, if that one has gone (Clear the stored PIN gives way to the switch; the Lock
   * after option list closed), to the control that now stands for it. Focus someone moved
   * elsewhere meanwhile is left alone.
   */
  private restoreFocus(change: AppLockChange, trigger: Element | null): void {
    afterNextRender(
      () => {
        const active = this.document.activeElement;
        if (active && active !== this.document.body) return;
        const target =
          trigger instanceof HTMLElement && trigger.isConnected
            ? trigger
            : this.standIn(change);
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  private standIn(change: AppLockChange): HTMLElement | null {
    const root = this.host.nativeElement;
    switch (change) {
      case 'clear-pin':
      case 'enable':
      case 'disable':
        return root.querySelector<HTMLElement>('#app-lock-switch');
      case 'lock-after':
        return root.querySelector<HTMLElement>(
          '[data-testid=app-lock-after-select] [role=combobox]',
        );
      case 'notification-text':
        return root.querySelector<HTMLElement>(
          '[data-testid=app-lock-notification-text] input:checked',
        );
      case 'change-pin':
        return root.querySelector<HTMLElement>(
          '[data-testid=app-lock-change-pin]',
        );
      default: {
        const unhandled: never = change;
        void unhandled;
        return null;
      }
    }
  }

  private finish(change: AppLockChange, end: AppLockFlowEnd): void {
    // The select and the radios show the stored values again whenever the change didn't
    // happen. After a render: the control already holds the choice, and re-binding an
    // unchanged value (an answer that came before any render) would not move it back.
    afterNextRender(
      () => {
        this.shownLockAfter.set(this.appLock.lockAfter());
        this.shownNotificationText.set(this.appLock.notificationText());
      },
      { injector: this.injector },
    );
    switch (end.kind) {
      case 'completed':
        if (change === 'change-pin') this.status.set(PIN_CHANGED);
        if (change === 'clear-pin') {
          // The switch's view replaces the note: say it once its live region is on screen.
          afterNextRender(() => this.status.set(STORED_PIN_CLEARED), {
            injector: this.injector,
          });
        }
        return;
      case 'stopped':
        return;
      case 'refused':
        this.error.set(end.message);
        return;
      case 'failed':
        this.error.set(failureMessage(change, end.reason, this.appName));
        // What the host can do may have changed (a store that broke): show what's true now.
        this.refresh();
        return;
      default: {
        const unhandled: never = end;
        void unhandled;
      }
    }
  }

  private refresh(): void {
    this.appLock
      .refreshSupport()
      .pipe(
        take(1),
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }
}
