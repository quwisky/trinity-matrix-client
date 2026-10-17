import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MockProvider } from 'ng-mocks';
import { Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  AccountDeletionWorkflow,
  type AccountDeletionResult,
  type AccountSignOutOutcome,
} from '@trinity/data-access/accounts';
import { AuthService, type AccountServerApi } from '@trinity/data-access/auth';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ExternalBrowserService,
  type AccountDeletionPrompts,
} from '@trinity/platform-native';
import { AccountDeletionLauncherAdapter } from './account-deletion-launcher.adapter';

const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';

function cleanup(
  remaining: readonly string[],
  kind: 'ready' | 'partial-cleanup' = 'ready',
): AccountSignOutOutcome {
  const base = {
    accountId: ALICE,
    activeAccountId: remaining[0] ?? null,
    remainingAccountIds: remaining,
  };
  return kind === 'ready'
    ? { kind, ...base }
    : {
        kind,
        ...base,
        issues: [{ scope: 'preferences', recovery: 'retry-sign-out' }],
      };
}

function deleted(outcome: AccountSignOutOutcome): AccountDeletionResult {
  return { kind: 'deleted', accountId: ALICE, cleanup: outcome };
}

function setup(
  options: {
    result?: AccountDeletionResult;
    api?: AccountServerApi;
  } = {},
) {
  const onTokenDied: (() => void)[] = [];
  const release = vi.fn();
  const late = new Subject<AccountDeletionResult>();
  TestBed.configureTestingModule({
    providers: [
      AccountDeletionLauncherAdapter,
      MockProvider(AccountDeletionWorkflow, {
        lateDeletions: late.asObservable(),
        delete: vi.fn(() => of(options.result ?? deleted(cleanup([BOB])))),
        checkDeletion: vi.fn(() =>
          of(options.result ?? deleted(cleanup([BOB]))),
        ),
        removeDeleted: vi.fn(() =>
          of(options.result ?? deleted(cleanup([BOB]))),
        ),
      }),
      MockProvider(AuthService, {
        accountManagementFor: vi.fn(() =>
          of(options.api ?? ({ kind: 'legacy' } as const)),
        ),
      }),
      MockProvider(MatrixClientService, {
        holdServerLogout: vi.fn(
          (_id: string, hooks?: { onTokenDied?: () => void }) => {
            if (hooks?.onTokenDied) onTokenDied.push(hooks.onTokenDied);
            return { tokenDied: () => false, release };
          },
        ),
      }),
      MockProvider(ExternalBrowserService, { open: vi.fn(() => of(true)) }),
      MockProvider(TrnToastService, { show: vi.fn() }),
      MockProvider(TrnSurfaceService, { closeAll: vi.fn() }),
      MockProvider(Router, { navigateByUrl: vi.fn(async () => true) }),
    ],
  });
  const prompts: AccountDeletionPrompts = {
    password: vi.fn(async () => 'pw'),
    confirmInBrowser: vi.fn(async () => true),
  };
  return {
    launcher: TestBed.inject(AccountDeletionLauncherAdapter),
    workflow: TestBed.inject(AccountDeletionWorkflow),
    matrix: TestBed.inject(MatrixClientService),
    browser: TestBed.inject(ExternalBrowserService),
    toast: TestBed.inject(TrnToastService),
    surfaces: TestBed.inject(TrnSurfaceService),
    router: TestBed.inject(Router),
    prompts,
    release,
    late,
    tokenDies: () => onTokenDied.forEach((hook) => hook()),
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('AccountDeletionLauncherAdapter', () => {
  describe('plan', () => {
    it('deletes in the app on a server with the legacy account API', async () => {
      const test = setup();

      await expect(firstValueFrom(test.launcher.plan(ALICE))).resolves.toEqual({
        kind: 'in-app',
      });
    });

    it('links to the provider page on an OAuth server', async () => {
      const test = setup({
        api: {
          kind: 'oauth',
          management: {
            url: 'https://auth.example.org/account/',
            actionsSupported: ['org.matrix.cross_signing_reset'],
          },
        },
      });

      await expect(firstValueFrom(test.launcher.plan(ALICE))).resolves.toEqual({
        kind: 'provider',
        url: 'https://auth.example.org/account/',
      });
    });

    it('has no link when the provider publishes none', async () => {
      const test = setup({ api: { kind: 'oauth', management: null } });

      await expect(firstValueFrom(test.launcher.plan(ALICE))).resolves.toEqual({
        kind: 'provider',
        url: null,
      });
    });
  });

  it('passes the dialog’s answers to the workflow', async () => {
    const test = setup();

    await firstValueFrom(
      test.launcher.delete({
        accountId: ALICE,
        erase: false,
        prompts: test.prompts,
      }),
    );

    const request = vi.mocked(test.workflow.delete).mock.calls[0][0];
    expect(request).toMatchObject({ accountId: ALICE, erase: false });
    await request.stages.password({ rejected: true });
    expect(test.prompts.password).toHaveBeenCalledWith({ rejected: true });
  });

  it('closes Settings, opens Rooms for the next account and says so', async () => {
    const test = setup();

    await expect(
      firstValueFrom(
        test.launcher.delete({
          accountId: ALICE,
          erase: true,
          prompts: test.prompts,
        }),
      ),
    ).resolves.toEqual({ kind: 'deleted' });
    expect(test.surfaces.closeAll).toHaveBeenCalled();
    expect(test.router.navigateByUrl).toHaveBeenCalledWith('/', {
      replaceUrl: true,
    });
    expect(test.toast.show).toHaveBeenCalledWith(
      `${ALICE} was deleted. You’re now using ${BOB}.`,
      { duration: 8000, variant: 'success' },
    );
    expect(test.launcher.deletedNotice()).toBeNull();
  });

  it('goes to sign-in with a notice when it was the last account', async () => {
    const test = setup({ result: deleted(cleanup([])) });

    await firstValueFrom(
      test.launcher.delete({
        accountId: ALICE,
        erase: true,
        prompts: test.prompts,
      }),
    );

    expect(test.router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
    expect(test.toast.show).not.toHaveBeenCalled();
    expect(test.launcher.deletedNotice()).toBe(ALICE);
    test.launcher.dismissDeletedNotice();
    expect(test.launcher.deletedNotice()).toBeNull();
  });

  it('reports leftover local data without calling the deletion failed', async () => {
    const test = setup({ result: deleted(cleanup([BOB], 'partial-cleanup')) });

    await expect(
      firstValueFrom(
        test.launcher.delete({
          accountId: ALICE,
          erase: true,
          prompts: test.prompts,
        }),
      ),
    ).resolves.toEqual({ kind: 'deleted' });
    expect(test.toast.show).toHaveBeenCalledWith(
      `${ALICE} was deleted. Some data on this device couldn’t be removed yet. Restart Trinity to finish.`,
      { duration: 8000, variant: 'danger' },
    );
  });

  it.each([
    [
      {
        kind: 'kept',
        accountId: ALICE,
        reason: 'rate-limited',
        retryAfterMs: 3000,
      },
      { kind: 'kept', reason: 'rate-limited', retryAfterMs: 3000 },
    ],
    [
      { kind: 'kept', accountId: ALICE, reason: 'cancelled' },
      { kind: 'kept', reason: 'cancelled' },
    ],
    [{ kind: 'unconfirmed', accountId: ALICE }, { kind: 'unconfirmed' }],
  ] as const)(
    'hands %o back to the dialog untouched',
    async (result, outcome) => {
      const test = setup({ result });

      await expect(
        firstValueFrom(
          test.launcher.delete({
            accountId: ALICE,
            erase: true,
            prompts: test.prompts,
          }),
        ),
      ).resolves.toEqual(outcome);
      expect(test.router.navigateByUrl).not.toHaveBeenCalled();
      expect(test.surfaces.closeAll).not.toHaveBeenCalled();
    },
  );

  describe('the provider page', () => {
    it('opens it and removes the account once its token stops working', async () => {
      const test = setup();

      await firstValueFrom(
        test.launcher.openProvider(ALICE, 'https://auth.example.org/account/'),
      );
      expect(test.browser.open).toHaveBeenCalledWith(
        'https://auth.example.org/account/',
      );
      expect(test.matrix.holdServerLogout).toHaveBeenCalledWith(
        ALICE,
        expect.anything(),
      );
      expect(test.workflow.removeDeleted).not.toHaveBeenCalled();

      test.tokenDies();
      await Promise.resolve();

      expect(test.workflow.removeDeleted).toHaveBeenCalledWith(ALICE);
      expect(test.toast.show).toHaveBeenCalledOnce();
      expect(test.release).toHaveBeenCalledWith({ deleted: true });
    });

    it('holds once however often the page is opened', async () => {
      const test = setup();

      await firstValueFrom(test.launcher.openProvider(ALICE, 'https://a/'));
      await firstValueFrom(test.launcher.openProvider(ALICE, 'https://a/'));

      expect(test.matrix.holdServerLogout).toHaveBeenCalledOnce();
    });

    it('finishes once when Check now and the dead token both notice', async () => {
      const test = setup();
      await firstValueFrom(test.launcher.openProvider(ALICE, 'https://a/'));

      await firstValueFrom(test.launcher.checkDeletion(ALICE));
      test.tokenDies();
      await Promise.resolve();

      expect(test.toast.show).toHaveBeenCalledOnce();
      expect(test.router.navigateByUrl).toHaveBeenCalledOnce();
    });
  });

  it('presents a deletion that settles after it was reported unconfirmed', () => {
    const test = setup();

    test.late.next(deleted(cleanup([])));

    expect(test.surfaces.closeAll).toHaveBeenCalled();
    expect(test.router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
    expect(test.launcher.deletedNotice()).toBe(ALICE);
  });

  it('checks with the server on Check now', async () => {
    const test = setup({
      result: { kind: 'kept', accountId: ALICE, reason: 'still-active' },
    });

    await expect(
      firstValueFrom(test.launcher.checkDeletion(ALICE)),
    ).resolves.toEqual({ kind: 'kept', reason: 'still-active' });
    expect(test.workflow.checkDeletion).toHaveBeenCalledWith(ALICE);
  });
});
