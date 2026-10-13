import {
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { Observable, Subscription, catchError, mergeMap, of } from 'rxjs';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  TrustDeviceConfirmationService,
  TrustService,
  TrustVerificationService,
} from '@trinity/data-access/trust';
import {
  DEVICE_CONFIRMATION_URL,
  showsAccountContent,
} from '../device-confirmation.guard';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';

/**
 * Cross-capability workflow (ADR 0001) for MSC4153 decision 2: Accounts reports new-device
 * sign-ins, Trust decides whether the active device still needs verifying, and this keeps
 * the app on the check until it does not. Owned by the Application Runtime session, which
 * subscribes before any sign-in can happen.
 */
@Injectable({ providedIn: 'root' })
export class DeviceConfirmationCoordinator {
  private readonly injector = inject(Injector);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly confirmation = inject(TrustDeviceConfirmationService);
  private readonly trust = inject(TrustService);
  private readonly router = inject(Router);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly presenter = inject(
    WorkspaceApplicationSurfacePresenterAdapter,
  );
  private readonly verification = inject(TrustVerificationService);
  /**
   * A recovery or verification flow is in progress: a trust dialog is open, or a
   * verification of this account's own devices (whose incoming-request dialog the
   * verification host shows) has not ended. Verifying another person cannot verify this
   * device, so it does not hold the check back.
   */
  private readonly trustFlowOpen = computed(() => {
    const active = this.verification.active();
    return (
      this.presenter.trustDialogOpen() ||
      (active !== null &&
        active.isSelfVerification &&
        active.stage !== 'done' &&
        active.stage !== 'cancelled')
    );
  });

  run(): Observable<never> {
    return new Observable<never>(() => {
      const work = new Subscription();
      let redirectRead: Subscription | null = null;
      work.add(
        this.accounts.newDevices
          .pipe(
            mergeMap(({ accountId, deviceId }) =>
              this.confirmation
                .require(accountId, deviceId)
                .pipe(catchError(() => of(undefined))),
            ),
          )
          .subscribe(),
      );
      const effects = [
        effect(
          () => {
            const accountId = this.accounts.activeAccountId();
            if (!accountId) return;
            untracked(() =>
              work.add(
                this.confirmation
                  .hydrate(accountId)
                  .subscribe({ error: () => undefined }),
              ),
            );
          },
          { injector: this.injector },
        ),
        effect(
          () => {
            const accountId = this.accounts.activeAccountId();
            const health = this.trust.health();
            if (
              !accountId ||
              health.availability !== 'coherent' ||
              !health.current.thisDeviceVerified
            ) {
              return;
            }
            untracked(() =>
              work.add(
                this.confirmation
                  .completeIfVerified(accountId)
                  .subscribe({ error: () => undefined }),
              ),
            );
          },
          { injector: this.injector },
        ),
        effect(
          () => {
            const required = this.confirmation.gate().kind === 'required';
            const flowOpen = required && this.trustFlowOpen();
            untracked(() => {
              // Whatever changed, a read started for the previous run is stale.
              if (redirectRead) {
                work.remove(redirectRead);
                redirectRead.unsubscribe();
                redirectRead = null;
              }
              // Owner decision 2026-10-12 (2): let a trust flow finish; this effect runs
              // again when it ends, and redirects only if the check is still required.
              // Away from Rooms and Settings there is nothing to redirect; the guard
              // checks again on the way back.
              if (
                !required ||
                flowOpen ||
                !showsAccountContent(this.router.url)
              ) {
                return;
              }
              // Just after an Account switch the gate can still reflect the previous
              // Account's status: act only on a fresh read of this exact Account.
              redirectRead = this.confirmation
                .confirmRequired()
                .pipe(catchError(() => of(false)))
                .subscribe((stillRequired) => {
                  if (
                    stillRequired &&
                    this.confirmation.gate().kind === 'required' &&
                    !this.trustFlowOpen()
                  ) {
                    this.sendToCheck();
                  }
                });
              work.add(redirectRead);
            });
          },
          { injector: this.injector },
        ),
      ];
      return () => {
        work.unsubscribe();
        for (const ref of effects) ref.destroy();
      };
    });
  }

  /**
   * Close every dialog first: Settings over Rooms is a dialog, not a route, so neither the
   * guard nor the redirect would remove it, and it would stay open over the check. No trust
   * flow is open here (the effect waits for one to end), so nothing closed is mid-flow.
   */
  private sendToCheck(): void {
    if (!showsAccountContent(this.router.url)) return;
    this.surfaces.closeAll();
    void this.router.navigateByUrl(DEVICE_CONFIRMATION_URL, {
      replaceUrl: true,
    });
  }
}
