import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MockProvider } from 'ng-mocks';
import { Subject, firstValueFrom, of, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TrnAlertService,
  TrnToastService,
  type TrnAlertChoice,
} from '@trinity/components/overlay';
import {
  ACCOUNT_REMOVAL_CONSEQUENCES,
  AccountRuntimeService,
  ROOM_KEYS_AT_RISK,
  ROOM_KEYS_MAY_BE_LOST,
  type AccountSignOutOutcome,
} from '@trinity/data-access/accounts';
import { SESSION_ENGINE } from '@trinity/data-access/matrix-client';
import { AccountRemovalLauncherAdapter } from './account-removal-launcher.adapter';

const LAST_ACCOUNT: AccountSignOutOutcome = {
  kind: 'ready',
  accountId: '@me:hs',
  activeAccountId: null,
  remainingAccountIds: [],
};

interface Options {
  readonly confirm?: boolean[];
  readonly choice?: TrnAlertChoice;
  readonly backedUp?: boolean | null;
  readonly signOut?: AccountSignOutOutcome;
  /** The sign-out's own stream, when a test settles it by hand. */
  readonly signOut$?: Observable<AccountSignOutOutcome>;
}

function setup(options: Options = {}) {
  const answers = [...(options.confirm ?? [true])];
  const confirm = vi.fn(() => of(answers.shift() ?? false));
  const choose = vi.fn(() => of(options.choice ?? 'cancel'));
  const show = vi.fn();
  const navigateByUrl = vi.fn(async () => true);
  const signOutAccount = vi.fn(
    () => options.signOut$ ?? of(options.signOut ?? LAST_ACCOUNT),
  );
  const roomKeysBackedUp = vi.fn(() =>
    of(options.backedUp === undefined ? true : options.backedUp),
  );
  TestBed.configureTestingModule({
    providers: [
      AccountRemovalLauncherAdapter,
      MockProvider(TrnAlertService, { confirm$: confirm, choose$: choose }),
      MockProvider(TrnToastService, { show }),
      MockProvider(Router, { navigateByUrl }),
      MockProvider(AccountRuntimeService, { signOutAccount }),
      { provide: SESSION_ENGINE, useValue: { roomKeysBackedUp } },
    ],
  });
  return {
    launcher: TestBed.inject(AccountRemovalLauncherAdapter),
    confirm,
    choose,
    show,
    navigateByUrl,
    signOutAccount,
    roomKeysBackedUp,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('AccountRemovalLauncherAdapter', () => {
  it('asks the account menu’s question, removes the last account and goes to sign-in', async () => {
    const test = setup();

    await expect(
      firstValueFrom(test.launcher.remove('@me:hs')),
    ).resolves.toEqual({ kind: 'removed', remainingAccountIds: [] });
    expect(test.confirm).toHaveBeenCalledWith({
      header: 'Remove account',
      message: `Account @me:hs\n\n${ACCOUNT_REMOVAL_CONSEQUENCES}`,
      confirmText: 'Remove account',
      variant: 'danger',
    });
    expect(test.signOutAccount).toHaveBeenCalledWith('@me:hs');
    expect(test.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
    // A clean removal says nothing.
    expect(test.show).not.toHaveBeenCalled();
  });

  it('stays in the app when other accounts remain', async () => {
    const test = setup({
      signOut: { ...LAST_ACCOUNT, remainingAccountIds: ['@alt:hs'] },
    });

    await expect(
      firstValueFrom(test.launcher.remove('@me:hs')),
    ).resolves.toEqual({ kind: 'removed', remainingAccountIds: ['@alt:hs'] });
    expect(test.navigateByUrl).not.toHaveBeenCalled();
    expect(test.show).not.toHaveBeenCalled();
  });

  it('keeps the account when the first question is cancelled', async () => {
    const test = setup({ confirm: [false] });

    await expect(
      firstValueFrom(test.launcher.remove('@me:hs')),
    ).resolves.toEqual({ kind: 'kept' });
    expect(test.roomKeysBackedUp).not.toHaveBeenCalled();
    expect(test.signOutAccount).not.toHaveBeenCalled();
  });

  it('offers the key export when key backup is incomplete, and keeps the account on Cancel', async () => {
    const test = setup({ backedUp: false });

    await expect(
      firstValueFrom(test.launcher.remove('@me:hs')),
    ).resolves.toEqual({ kind: 'kept' });
    expect(test.choose).toHaveBeenCalledWith({
      header: 'Room keys are not backed up',
      message: `Account @me:hs\n\n${ROOM_KEYS_AT_RISK}`,
      alternativeText: 'Export keys',
      confirmText: 'Remove anyway',
      variant: 'danger',
    });
    expect(test.signOutAccount).not.toHaveBeenCalled();
  });

  it('hands Export keys back to the caller and keeps the account', async () => {
    const test = setup({ backedUp: false, choice: 'alternative' });

    await expect(
      firstValueFrom(test.launcher.remove('@me:hs')),
    ).resolves.toEqual({ kind: 'export-keys' });
    expect(test.signOutAccount).not.toHaveBeenCalled();
  });

  it('removes the account when that step is answered with Remove anyway', async () => {
    const test = setup({ backedUp: false, choice: 'confirm' });

    await firstValueFrom(test.launcher.remove('@me:hs'));

    expect(test.signOutAccount).toHaveBeenCalledWith('@me:hs');
  });

  it('warns without an export when the backup status cannot be read', async () => {
    const test = setup({ backedUp: null, confirm: [true, false] });

    await expect(
      firstValueFrom(test.launcher.remove('@me:hs')),
    ).resolves.toEqual({ kind: 'kept' });
    expect(test.choose).not.toHaveBeenCalled();
    expect(test.confirm).toHaveBeenLastCalledWith({
      header: 'Room keys may not be backed up',
      message: `Account @me:hs\n\n${ROOM_KEYS_MAY_BE_LOST}`,
      confirmText: 'Remove anyway',
      variant: 'danger',
    });
  });

  it('skips the key step when key backup holds every room key', async () => {
    const test = setup({ backedUp: true });

    await firstValueFrom(test.launcher.remove('@me:hs'));

    expect(test.choose).not.toHaveBeenCalled();
    expect(test.confirm).toHaveBeenCalledOnce();
    expect(test.signOutAccount).toHaveBeenCalledWith('@me:hs');
  });

  it.each([
    [
      'restart-application',
      'Account removal finished with some cleanup incomplete. Restart Trinity before trying again.',
    ],
    [
      'retry-sign-out',
      'Account removal finished with some cleanup incomplete. Retry it to run only safe remaining work.',
    ],
  ] as const)(
    'says when cleanup is incomplete (%s), as the account menu did',
    async (recovery, message) => {
      const test = setup({
        signOut: {
          ...LAST_ACCOUNT,
          kind: 'partial-cleanup',
          issues: [{ scope: 'indexed-db', recovery }],
        },
      });

      await expect(
        firstValueFrom(test.launcher.remove('@me:hs')),
      ).resolves.toEqual({ kind: 'removed', remainingAccountIds: [] });
      expect(test.show).toHaveBeenCalledWith(message, {
        duration: 4000,
        variant: 'danger',
      });
    },
  );

  it('says when removal is still running', async () => {
    const test = setup({
      signOut: {
        kind: 'uncertain-cleanup',
        accountId: '@me:hs',
        issues: [],
        pending: [],
      },
    });

    await expect(
      firstValueFrom(test.launcher.remove('@me:hs')),
    ).resolves.toEqual({ kind: 'still-running' });
    expect(test.show).toHaveBeenCalledWith(
      'Account removal is still running. Closing this message does not cancel it.',
      { duration: 4000, variant: 'danger' },
    );
    // Nothing is removed yet: stay where the person is.
    expect(test.navigateByUrl).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'failed',
      accountId: '@me:hs',
      failure: 'local-state-unavailable',
      recovery: 'retry-sign-out',
    },
    {
      kind: 'transition-in-progress',
      accountId: '@me:hs',
      operation: 'switching-account',
    },
  ] as const)(
    'reports a removal that could not run ($kind)',
    async (outcome) => {
      const test = setup({ signOut: outcome as AccountSignOutOutcome });

      await expect(
        firstValueFrom(test.launcher.remove('@me:hs')),
      ).resolves.toEqual({ kind: 'failed' });
      expect(test.navigateByUrl).not.toHaveBeenCalled();
    },
  );

  it('says when cleanup is incomplete and goes to sign-in even when the caller has gone', () => {
    // The new-device check is destroyed by the sign-out it started: the removal's own
    // messages and navigation must not depend on that caller's subscription.
    const signOut = new Subject<AccountSignOutOutcome>();
    const test = setup({ signOut$: signOut });

    const caller = test.launcher.remove('@me:hs').subscribe();
    expect(test.signOutAccount).toHaveBeenCalledWith('@me:hs');
    caller.unsubscribe();
    signOut.next({
      ...LAST_ACCOUNT,
      kind: 'partial-cleanup',
      issues: [{ scope: 'indexed-db', recovery: 'retry-sign-out' }],
    });
    signOut.complete();

    expect(test.show).toHaveBeenCalledWith(
      'Account removal finished with some cleanup incomplete. Retry it to run only safe remaining work.',
      { duration: 4000, variant: 'danger' },
    );
    expect(test.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });

  it('still hands the outcome to a caller that stays', async () => {
    const signOut = new Subject<AccountSignOutOutcome>();
    const test = setup({ signOut$: signOut });

    const outcome = firstValueFrom(test.launcher.remove('@me:hs'));
    signOut.next({ ...LAST_ACCOUNT, remainingAccountIds: ['@alt:hs'] });
    signOut.complete();

    await expect(outcome).resolves.toEqual({
      kind: 'removed',
      remainingAccountIds: ['@alt:hs'],
    });
  });
});
