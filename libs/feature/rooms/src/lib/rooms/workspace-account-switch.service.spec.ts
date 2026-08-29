import { TestBed } from '@angular/core/testing';
import {
  AccountRuntimeService,
  type AccountSwitchOutcome,
} from '@trinity/data-access/accounts';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, firstValueFrom, of, switchMap } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { WorkspaceAccountSwitchService } from './workspace-account-switch.service';

const ready = {
  kind: 'ready',
  accountId: '@next:hs',
  metrics: {
    durationMs: 4,
    projectionDurationMs: 2,
    projectionCount: 3,
  },
} satisfies AccountSwitchOutcome;

function setup(
  prepare: Observable<boolean> = of(true),
  accountOutcome: Observable<AccountSwitchOutcome> = of(ready),
  repair: Observable<boolean> = of(true),
) {
  const navigation = {
    resetViewScope: vi.fn(),
    prepareAccountSwitch: vi.fn(() => prepare),
    repairAccountSelection: vi.fn(() => repair),
  };
  const accounts = {
    switchActiveAccount: vi.fn(
      (_accountId: string, prepareWorkspace: () => Observable<void>) =>
        prepareWorkspace().pipe(switchMap(() => accountOutcome)),
    ),
  };
  TestBed.configureTestingModule({
    providers: [
      WorkspaceAccountSwitchService,
      MockProvider(RoomShellNavigationService, navigation),
      MockProvider(AccountRuntimeService, accounts),
    ],
  });
  return {
    service: TestBed.inject(WorkspaceAccountSwitchService),
    navigation,
    accounts,
  };
}

describe('WorkspaceAccountSwitchService', () => {
  it('prepares the Workspace before committing and repairs after readiness', async () => {
    const preparation = new Subject<boolean>();
    const accountOutcome = new Subject<AccountSwitchOutcome>();
    const repair = new Subject<boolean>();
    const { service, navigation, accounts } = setup(
      preparation,
      accountOutcome,
      repair,
    );
    const destination = {
      kind: 'room',
      roomId: '!room:hs',
      source: 'user',
    } as const;
    let settled = false;

    const result = firstValueFrom(
      service.switchAccount('@next:hs', destination),
    ).then((outcome) => {
      settled = true;
      return outcome;
    });

    expect(navigation.resetViewScope).toHaveBeenCalledOnce();
    expect(navigation.prepareAccountSwitch).toHaveBeenCalledOnce();
    expect(accounts.switchActiveAccount).toHaveBeenCalledWith(
      '@next:hs',
      expect.any(Function),
    );
    preparation.next(true);
    preparation.complete();

    accountOutcome.next(ready);
    accountOutcome.complete();
    expect(navigation.repairAccountSelection).toHaveBeenCalledWith(destination);
    expect(settled).toBe(false);
    repair.next(true);
    repair.complete();

    await expect(result).resolves.toEqual(ready);
  });

  it('leaves the safe fallback selected after a typed switch failure', async () => {
    const failed = {
      kind: 'failed',
      accountId: '@missing:hs',
      failure: 'account-unavailable',
    } satisfies AccountSwitchOutcome;
    const { service, navigation } = setup(of(true), of(failed), of(true));

    await expect(
      firstValueFrom(service.switchAccount('@missing:hs', { kind: 'home' })),
    ).resolves.toEqual(failed);
    expect(navigation.repairAccountSelection).not.toHaveBeenCalled();
  });

  it('joins an identical Workspace destination without preparing or repairing twice', async () => {
    const accountOutcome = new Subject<AccountSwitchOutcome>();
    const repair = new Subject<boolean>();
    const { service, navigation, accounts } = setup(
      of(true),
      accountOutcome,
      repair,
    );
    const destination = { kind: 'space', spaceId: '!space:hs' } as const;

    const first = firstValueFrom(
      service.switchAccount('@next:hs', destination),
    );
    const repeated = firstValueFrom(
      service.switchAccount('@next:hs', destination),
    );

    expect(accounts.switchActiveAccount).toHaveBeenCalledOnce();
    expect(navigation.resetViewScope).toHaveBeenCalledOnce();
    accountOutcome.next(ready);
    accountOutcome.complete();
    expect(navigation.repairAccountSelection).toHaveBeenCalledOnce();
    repair.next(true);
    repair.complete();

    await expect(first).resolves.toEqual(ready);
    await expect(repeated).resolves.toEqual(ready);
  });

  it('rejects a conflicting rapid destination before mutating the Workspace', async () => {
    const accountOutcome = new Subject<AccountSwitchOutcome>();
    const { service, navigation, accounts } = setup(of(true), accountOutcome);
    const first = service
      .switchAccount('@next:hs', { kind: 'home' })
      .subscribe();

    await expect(
      firstValueFrom(
        service.switchAccount('@other:hs', {
          kind: 'room',
          roomId: '!other:hs',
          source: 'user',
        }),
      ),
    ).resolves.toEqual({
      kind: 'transition-in-progress',
      accountId: '@other:hs',
      operation: 'switching-account',
    });
    expect(accounts.switchActiveAccount).toHaveBeenCalledOnce();
    expect(navigation.resetViewScope).toHaveBeenCalledOnce();
    expect(navigation.prepareAccountSwitch).toHaveBeenCalledOnce();

    first.unsubscribe();
  });

  it.each([
    ['preparation', of(false), of(true)],
    ['repair', of(true), of(false)],
  ] as const)(
    'reports a rejected Workspace %s as a typed failure',
    async (_phase, preparation, repair) => {
      const { service } = setup(preparation, of(ready), repair);

      await expect(
        firstValueFrom(service.switchAccount('@next:hs', { kind: 'home' })),
      ).resolves.toEqual({
        kind: 'failed',
        accountId: '@next:hs',
        failure: 'workspace-transition-failed',
      });
    },
  );
});
