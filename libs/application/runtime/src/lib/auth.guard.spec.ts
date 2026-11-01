import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { MockProvider } from 'ng-mocks';
import { Observable, defer, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authGuard } from './auth.guard';
import {
  AccountRuntimeService,
  type AccountRestoreResult,
  type AccountRuntimeState,
} from '@trinity/data-access/accounts';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

function run(): Observable<boolean | UrlTree> {
  return TestBed.runInInjectionContext(
    () => authGuard({} as never, {} as never) as Observable<boolean | UrlTree>,
  );
}

describe('authGuard', () => {
  const hasActiveAccount = signal(false);
  const runtimeState = signal<AccountRuntimeState>({ phase: 'idle' });
  const reauthTargets = signal<readonly string[]>([]);
  let accounts: AccountRuntimeService;
  let router: Router;
  let loginTree: UrlTree;

  beforeEach(() => {
    loginTree = new UrlTree();
    TestBed.configureTestingModule({
      providers: [
        MockProvider(AccountRuntimeService, {
          hasActiveAccount: hasActiveAccount.asReadonly(),
          state: runtimeState.asReadonly(),
        }),
        MockProvider(MatrixClientService, {
          reauthTargets: reauthTargets.asReadonly(),
        }),
        MockProvider(Router),
      ],
    });
    accounts = TestBed.inject(AccountRuntimeService);
    router = TestBed.inject(Router);
    hasActiveAccount.set(false);
    runtimeState.set({ phase: 'idle' });
    reauthTargets.set([]);
    vi.mocked(router.createUrlTree).mockReturnValue(loginTree);
  });

  it('allows navigation when an Active Account is already ready', async () => {
    hasActiveAccount.set(true);
    expect(await firstValueFrom(run())).toBe(true);
    expect(accounts.restoreSavedAccounts).not.toHaveBeenCalled();
  });

  it('restores the stored accounts and allows navigation', async () => {
    vi.mocked(accounts.restoreSavedAccounts).mockReturnValue(
      of(result('restored')),
    );
    expect(await firstValueFrom(run())).toBe(true);
    expect(accounts.restoreSavedAccounts).toHaveBeenCalled();
  });

  it('redirects to /login when nothing is stored', async () => {
    vi.mocked(accounts.restoreSavedAccounts).mockReturnValue(
      of(result('no-accounts')),
    );
    expect(await firstValueFrom(run())).toBe(loginTree);
  });

  describe('with a signed-out OAuth account', () => {
    function expectPrefilledReauth(): void {
      expect(router.createUrlTree).toHaveBeenCalledExactlyOnceWith(['/login'], {
        queryParams: { reauth: '@first:hs' },
      });
    }

    it('redirects to the prefilled re-auth once settled', async () => {
      reauthTargets.set(['@first:hs', '@second:hs']);
      runtimeState.set({ phase: 'settled', result: result('no-accounts') });

      expect(await firstValueFrom(run())).toBe(loginTree);
      expectPrefilledReauth();
    });

    it('redirects to the prefilled re-auth after a restore', async () => {
      // Marked by the restore itself, so it must be read once the restore has finished.
      vi.mocked(accounts.restoreSavedAccounts).mockReturnValue(
        defer(() => {
          reauthTargets.set(['@first:hs']);
          return of(result('no-accounts'));
        }),
      );

      expect(await firstValueFrom(run())).toBe(loginTree);
      expectPrefilledReauth();
    });

    it('redirects to the prefilled re-auth when the restore fails', async () => {
      reauthTargets.set(['@first:hs']);
      vi.mocked(accounts.restoreSavedAccounts).mockReturnValue(
        throwError(() => new Error('restore failed')),
      );

      expect(await firstValueFrom(run())).toBe(loginTree);
      expectPrefilledReauth();
    });
  });

  it('redirects to the blank login with no target', async () => {
    runtimeState.set({ phase: 'settled', result: result('no-accounts') });

    await firstValueFrom(run());

    expect(router.createUrlTree).toHaveBeenCalledExactlyOnceWith(['/login']);
  });

  it('does not repeat a settled Application Runtime restoration', async () => {
    runtimeState.set({ phase: 'settled', result: result('no-accounts') });

    expect(await firstValueFrom(run())).toBe(loginTree);
    expect(accounts.restoreSavedAccounts).not.toHaveBeenCalled();
  });

  it('redirects to /login when restore fails', async () => {
    vi.mocked(accounts.restoreSavedAccounts).mockReturnValue(
      throwError(() => new Error('restore boom')),
    );
    expect(await firstValueFrom(run())).toBe(loginTree);
  });
});

function result(kind: 'restored' | 'no-accounts'): AccountRestoreResult {
  return kind === 'restored'
    ? {
        kind,
        activeAccountId: '@me:hs',
        accounts: [
          {
            kind: 'ready',
            accountId: '@me:hs',
            role: 'active',
          },
        ],
      }
    : { kind, accounts: [] };
}
