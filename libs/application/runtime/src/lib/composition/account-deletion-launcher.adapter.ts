import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Observable, ReplaySubject, defer, finalize, map } from 'rxjs';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  AccountDeletionWorkflow,
  type AccountDeletionResult,
  type AccountSignOutOutcome,
} from '@trinity/data-access/accounts';
import { AuthService, deletionLink } from '@trinity/data-access/auth';
import {
  MatrixClientService,
  type ServerLogoutHold,
} from '@trinity/data-access/matrix-client';
import {
  ExternalBrowserService,
  type AccountDeletionLauncher,
  type AccountDeletionOutcome,
  type AccountDeletionPlan,
  type AccountDeletionPrompts,
} from '@trinity/platform-native';

const DELETED_TOAST_MS = 8000;

/**
 * `ACCOUNT_DELETION_LAUNCHER`: Settings › Account's "Delete account". Once the server has
 * deleted the account, the move to the next account or to sign-in and its message belong
 * to this flow: the dialog and Settings that asked are closed by it.
 */
@Injectable({ providedIn: 'root' })
export class AccountDeletionLauncherAdapter implements AccountDeletionLauncher {
  private readonly workflow = inject(AccountDeletionWorkflow);
  private readonly auth = inject(AuthService);
  private readonly matrix = inject(MatrixClientService);
  private readonly browser = inject(ExternalBrowserService);
  private readonly toast = inject(TrnToastService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly router = inject(Router);

  /** Accounts handed to their provider's page this session, by account id. */
  private readonly providerHolds = new Map<string, ServerLogoutHold>();
  /** Accounts whose deletion has been presented, so two detections say it once. */
  private readonly presented = new Set<string>();
  private readonly notice = signal<string | null>(null);
  readonly deletedNotice = this.notice.asReadonly();

  constructor() {
    // A deletion left unconfirmed can settle later, after its dialog has gone.
    this.workflow.lateDeletions
      .pipe(takeUntilDestroyed())
      .subscribe((result) => this.settle(result));
  }

  plan(accountId: string): Observable<AccountDeletionPlan> {
    return this.auth.accountManagementFor(accountId).pipe(
      map((api): AccountDeletionPlan => {
        if (api.kind === 'legacy') return { kind: 'in-app' };
        return {
          kind: 'provider',
          url: api.management ? deletionLink(api.management) : null,
        };
      }),
    );
  }

  delete(request: {
    readonly accountId: string;
    readonly erase: boolean;
    readonly prompts: AccountDeletionPrompts;
  }): Observable<AccountDeletionOutcome> {
    const { prompts } = request;
    return this.owned(
      this.workflow.delete({
        accountId: request.accountId,
        erase: request.erase,
        stages: {
          password: (context) => prompts.password(context),
          confirmInBrowser: (step) => prompts.confirmInBrowser(step),
        },
      }),
    );
  }

  checkDeletion(accountId: string): Observable<AccountDeletionOutcome> {
    return this.owned(this.workflow.checkDeletion(accountId));
  }

  openProvider(accountId: string, url: string): Observable<boolean> {
    return defer(() => {
      if (!this.providerHolds.get(accountId)?.isHeld()) {
        this.providerHolds.set(
          accountId,
          this.matrix.holdServerLogout(accountId, {
            onTokenDied: () => this.finishAtProvider(accountId),
          }),
        );
      }
      return this.browser.open(url);
    });
  }

  dismissDeletedNotice(): void {
    this.notice.set(null);
  }

  /**
   * The provider revoked the token. Without the hold this would be the plain hard-logout
   * wipe, which cannot claim a deletion: only a page Trinity opened makes it one.
   */
  private finishAtProvider(accountId: string): void {
    const hold = this.providerHolds.get(accountId);
    this.owned(this.workflow.removeDeleted(accountId))
      .pipe(
        finalize(() => {
          this.providerHolds.delete(accountId);
          hold?.release({ deleted: true });
        }),
      )
      .subscribe();
  }

  /** Runs the request to its end even when the dialog that asked has gone. */
  private owned(
    source: Observable<AccountDeletionResult>,
  ): Observable<AccountDeletionOutcome> {
    const outcome = new ReplaySubject<AccountDeletionOutcome>(1);
    source.pipe(map((result) => this.settle(result))).subscribe(outcome);
    return outcome.asObservable();
  }

  private settle(result: AccountDeletionResult): AccountDeletionOutcome {
    switch (result.kind) {
      case 'deleted':
        this.present(result.accountId, result.cleanup);
        return { kind: 'deleted' };
      case 'kept':
        return result.retryAfterMs === undefined
          ? { kind: 'kept', reason: result.reason }
          : {
              kind: 'kept',
              reason: result.reason,
              retryAfterMs: result.retryAfterMs,
            };
      case 'unconfirmed':
        return { kind: 'unconfirmed' };
    }
  }

  private present(accountId: string, cleanup: AccountSignOutOutcome): void {
    if (this.presented.has(accountId)) return;
    this.presented.add(accountId);
    this.providerHolds.get(accountId)?.release({ deleted: true });
    this.providerHolds.delete(accountId);
    this.surfaces.closeAll();
    const settled =
      cleanup.kind === 'ready' || cleanup.kind === 'partial-cleanup'
        ? cleanup
        : null;
    const next = settled
      ? settled.activeAccountId
      : (this.matrix.accountIds().find((id) => id !== accountId) ?? null);
    const complete = cleanup.kind === 'ready';
    if (!next) {
      this.notice.set(accountId);
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      if (complete) return;
    } else {
      void this.router.navigateByUrl('/', { replaceUrl: true });
    }
    this.toast.show(
      complete
        ? `${accountId} was deleted. You’re now using ${next}.`
        : `${accountId} was deleted. Some of its data couldn’t be removed from this device.`,
      { duration: DELETED_TOAST_MS, variant: complete ? 'success' : 'danger' },
    );
  }
}
