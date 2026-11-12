import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  viewChild,
  type ElementRef,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  PRIMARY_OUTLET,
  Router,
  RouterOutlet,
} from '@angular/router';
import { TrnButton } from '@trinity/components/controls';
import {
  BannerComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import {
  TrnDialogRef,
  TrnSurfaceService,
  TrnToasterComponent,
} from '@trinity/components/overlay';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { AppLockService } from '@trinity/data-access/app-lock';
import { SessionLockService } from '@trinity/platform-native';
import { markRoutedPage } from '@trinity/util/ui';
import { filter, finalize, map, take } from 'rxjs';
import { ApplicationRuntimeService } from '../application-runtime.service';
import {
  APPLICATION_STARTUP_STAGES,
  APPLICATION_STARTUP_STALLED_CODE,
  type ApplicationStartupRecovery,
  type ApplicationStartupStage,
} from '../application-runtime.models';
import {
  CapabilityStatusService,
  secondaryRecoveryLabel,
} from '../capability-status.service';
import { VerificationHostComponent } from '../verification-host/verification-host.component';
import { ApplicationRecoveryPresenter } from './application-recovery.presenter';
import { AppLockCoverComponent } from './app-lock-cover/app-lock-cover.component';
import { SessionLockNoticeComponent } from './session-lock-notice/session-lock-notice.component';
import { sessionLockNotice } from './session-lock-notice/session-lock-notice.model';
import { SystemStatusComponent } from './system-status/system-status.component';
import { TitleBarComponent } from './title-bar/title-bar.component';
import { TrinityApplicationSessionAdapter } from '../composition/trinity-application-session.adapter';
import { AppLockLifecycleBinding } from '../composition/app-lock-lifecycle.binding';

/**
 * How long a tab waiting for another tab shows the startup spinner before the notice. A
 * reloaded tab may ask before the browser frees its old page's lock; it is usually granted
 * within this time, so it never flashes "Trinity is open in another tab".
 */
const WAITING_NOTICE_DELAY_MS = 500;

/** A healthy stage settles well within this; the watchdog's sum of budgets is minutes away. */
export const STARTUP_STALL_NOTICE_MS = 15_000;

@Component({
  selector: 'trn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './application-root.component.html',
  styleUrl: './application-root.component.scss',
  imports: [
    RouterOutlet,
    TrnButton,
    BannerComponent,
    VerificationHostComponent,
    TrnToasterComponent,
    TrnSpinnerComponent,
    TitleBarComponent,
    SessionLockNoticeComponent,
    AppLockCoverComponent,
  ],
})
export class ApplicationRootComponent {
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly recovery = inject(ApplicationRecoveryPresenter);
  private readonly session = inject(TrinityApplicationSessionAdapter);
  private readonly router = inject(Router);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly sessionLock = inject(SessionLockService);
  private readonly showStartupDetail = signal(false);
  private readonly waitingNoticeDue = signal(false);
  private readonly stallDue = signal(false);
  private readonly removingStalledAccount = signal(false);
  private readonly startupStatus =
    viewChild<ElementRef<HTMLElement>>('startupStatus');
  private readonly hasActiveAccount = inject(AccountRuntimeService)
    .hasActiveAccount;
  private readonly routeUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly status = inject(CapabilityStatusService);
  readonly state = this.runtime.state;
  readonly booting = computed(() => {
    const phase = this.state().phase;
    return (
      phase === 'stopped' ||
      phase === 'starting' ||
      phase === 'stopping' ||
      // Never the routes while another tab runs Trinity; the notice after a short delay.
      (phase === 'waiting-for-session' && !this.waitingNoticeDue())
    );
  });
  readonly startupStep = computed(() => {
    const state = this.state();
    return state.phase === 'starting' && this.showStartupDetail()
      ? startupStep(state.stage)
      : null;
  });
  /** Still starting with no stage progress for {@link STARTUP_STALL_NOTICE_MS}. */
  readonly stalled = computed(
    () => this.state().phase === 'starting' && this.stallDue(),
  );
  /** A stalled attempt ended for account removal: say so, not "could not finish starting". */
  readonly removingAccount = computed(() => {
    const state = this.state();
    return (
      this.removingStalledAccount() &&
      state.phase === 'blocked' &&
      state.failure.diagnostic.code === APPLICATION_STARTUP_STALLED_CODE
    );
  });
  /** Only a restored account can be removed; before that there is nothing to remove. */
  readonly stalledAccountRemovable = computed(() => {
    const state = this.state();
    return (
      state.phase === 'starting' &&
      APPLICATION_STARTUP_STAGES.indexOf(state.stage) >
        APPLICATION_STARTUP_STAGES.indexOf('account-restoration') &&
      this.hasActiveAccount()
    );
  });
  readonly blocked = computed(() => {
    const state = this.state();
    return state.phase === 'blocked' ? state : null;
  });
  readonly sessionNotice = computed(() =>
    sessionLockNotice(this.state(), this.sessionLock.state()),
  );
  readonly recoveryAction = computed(() =>
    recoveryAction(
      this.blocked()?.failure.recovery ?? 'retry-startup',
      this.blocked()?.failure.diagnostic.code,
    ),
  );

  protected readonly markRoutedPage = markRoutedPage;
  /** Hides the workspace while locked, so a removed or glitched cover never shows content. */
  protected readonly appLocked = inject(AppLockService).locked;
  protected readonly isShellRoute = computed(
    () =>
      this.router.parseUrl(this.routeUrl()).root.children[PRIMARY_OUTLET]
        ?.segments[0]?.path === 'rooms',
  );

  constructor() {
    this.session
      .runInteractions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
    // App lock's away timer and shell state live as long as the app, signed in or not.
    inject(AppLockLifecycleBinding)
      .run()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
    const timer = window.setTimeout(
      () => this.showStartupDetail.set(true),
      500,
    );
    this.destroyRef.onDestroy(() => window.clearTimeout(timer));
    this.revealAfter(
      computed(() => this.state().phase === 'waiting-for-session'),
      WAITING_NOTICE_DELAY_MS,
      this.waitingNoticeDue,
    );
    this.revealAfter(
      computed(() => {
        const state = this.state();
        return state.phase === 'starting'
          ? `${state.attempt}:${state.stage}`
          : null;
      }),
      STARTUP_STALL_NOTICE_MS,
      this.stallDue,
    );
    this.presentSystemStatus();
    // The removal began from the stall notice, whose button is gone: keep focus on the screen.
    effect(() => {
      if (this.removingAccount()) this.startupStatus()?.nativeElement.focus();
    });
  }

  dismissSummary(): void {
    for (const entry of this.status.visibleEntries())
      this.status.dismiss(entry);
  }

  readonly secondaryLabel = secondaryRecoveryLabel;

  recover(choice?: ApplicationStartupRecovery): void {
    const recovery = choice ?? this.blocked()?.failure.recovery;
    if (!recovery) return;
    this.recovery
      .confirmAndRecover(recovery)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => this.recovery.present(outcome));
  }

  retryStalled(): void {
    this.recover('retry-startup');
    // Its button goes with the stall notice; keep keyboard and screen-reader users in place.
    this.startupStatus()?.nativeElement.focus();
  }

  removeStalledAccount(): void {
    this.removingStalledAccount.set(true);
    this.recovery
      .confirmAndRecover(
        'reauthenticate',
        toObservable(this.stalled, { injector: this.injector }).pipe(
          filter((stalled) => !stalled),
        ),
      )
      .pipe(
        take(1),
        finalize(() => this.removingStalledAccount.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => this.recovery.present(outcome));
  }

  useHere(): void {
    this.sessionLock.requestHandover();
  }

  /** Sets `due` once `key` has held one truthy value for `delayMs`; any change restarts the wait. */
  private revealAfter(
    key: () => unknown,
    delayMs: number,
    due: WritableSignal<boolean>,
  ): void {
    let timer: number | undefined;
    effect(() => {
      const current = key();
      untracked(() => {
        window.clearTimeout(timer);
        timer = undefined;
        due.set(false);
        if (current) {
          timer = window.setTimeout(() => due.set(true), delayMs);
        }
      });
    });
    this.destroyRef.onDestroy(() => window.clearTimeout(timer));
  }

  /** System status follows its state as a surface; any close of the surface clears the state. */
  private presentSystemStatus(): void {
    let ref: TrnDialogRef<void> | null = null;
    effect(() => {
      const open = this.status.open();
      untracked(() => {
        if (open && !ref) {
          const opened = this.surfaces.open<void, SystemStatusComponent>(
            SystemStatusComponent,
            {
              ariaLabel: 'System status',
              autoFocus: '[data-autofocus]',
              detents: ['medium', 'large'],
            },
          );
          ref = opened;
          opened.closed.subscribe(() => {
            if (ref !== opened) return;
            ref = null;
            this.status.close();
          });
        } else if (!open && ref) {
          const closing = ref;
          ref = null;
          closing.close();
        }
      });
    });
  }
}

function startupStep(stage: ApplicationStartupStage): string {
  switch (stage) {
    case 'host-negotiation':
      return 'Checking this device…';
    case 'session-lock':
      return 'Checking for other tabs…';
    case 'preference-hydration':
      return 'Restoring your preferences…';
    case 'account-restoration':
      return 'Restoring your accounts…';
    case 'session-capabilities':
      return 'Preparing messaging…';
    case 'workspace-restoration':
      return 'Opening your chats…';
    case 'readiness':
      return 'Finishing startup…';
    default: {
      const unhandled: never = stage;
      void unhandled;
      return 'Finishing startup…';
    }
  }
}

function recoveryAction(
  recovery: ApplicationStartupRecovery,
  code?: string,
): {
  readonly label: string;
  readonly detail: string;
} {
  if (code === 'account-secure-storage-unavailable') {
    return {
      label: 'Retry startup',
      detail:
        'Your system keychain is locked or unavailable. Unlock it and try again.',
    };
  }
  if (code === 'account-local-state-unavailable') {
    return {
      label: 'Retry startup',
      detail:
        'Trinity could not read its saved data on this device. Try again before removing anything.',
    };
  }
  switch (recovery) {
    case 'reauthenticate':
      return {
        label: 'Sign in again',
        detail:
          'The required account session is unavailable. Remove it and return to sign in.',
      };
    case 'reset-installation':
      return {
        label: 'Reset this installation',
        detail:
          'Required local application data is unavailable. Erase it and return to sign in.',
      };
    case 'reset-preferences':
      return {
        label: 'Reset preferences',
        detail:
          'Required preferences could not be read. Restore local defaults and try again.',
      };
    case 'retry-startup':
      return {
        label: 'Retry startup',
        detail:
          'A required part of Trinity did not become ready. Your data was not rolled back.',
      };
  }
}
