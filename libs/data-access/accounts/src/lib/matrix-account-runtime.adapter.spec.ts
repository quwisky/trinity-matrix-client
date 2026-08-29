import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { signal } from '@angular/core';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  AccountAlreadyStoredError,
  SessionStorageService,
} from '@trinity/platform-native';
import { AuthenticatedAccountGrant } from './authenticated-account-grant';
import type { AccountEstablishmentIntent } from './account-runtime.models';
import { MatrixAccountRuntimeAdapter } from './matrix-account-runtime.adapter';

const session = {
  baseUrl: 'https://hs',
  userId: '@new:hs',
  deviceId: 'DEVICE',
  accessToken: 'access',
};

const activeIntent = {
  placement: 'active',
  liveAccounts: 'replace',
  accountRecord: 'upsert',
} satisfies AccountEstablishmentIntent;

function setup(activeAccountId: string | null = '@old:hs') {
  TestBed.configureTestingModule({
    providers: [
      MatrixAccountRuntimeAdapter,
      MockProvider(MatrixClientService, {
        activeUserId: signal(activeAccountId).asReadonly(),
        clientFor: vi.fn(() => ({}) as never),
        rollbackAccountStart: vi.fn(() => of(void 0)),
      }),
      MockProvider(SessionStorageService),
    ],
  });
  return {
    adapter: TestBed.inject(MatrixAccountRuntimeAdapter),
    matrix: TestBed.inject(MatrixClientService),
    storage: TestBed.inject(SessionStorageService),
  };
}

describe('MatrixAccountRuntimeAdapter', () => {
  it('prepares only live Accounts for an Active Account switch', async () => {
    const { adapter, matrix } = setup();

    await expect(
      firstValueFrom(adapter.prepareActiveAccount('@next:hs')),
    ).resolves.toEqual({ kind: 'ready' });
    vi.mocked(matrix.clientFor).mockReturnValue(null);
    await expect(
      firstValueFrom(adapter.prepareActiveAccount('@missing:hs')),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'account-unavailable',
    });
  });

  it('persists the Active pointer before publishing the switched client', async () => {
    const { adapter, matrix, storage } = setup();
    const order: string[] = [];
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
      defer(() => {
        order.push('persist-active');
        return of(void 0);
      }),
    );
    vi.mocked(matrix.setActive).mockImplementation(() => {
      order.push('activate');
    });

    await expect(
      firstValueFrom(adapter.commitActiveAccount('@next:hs')),
    ).resolves.toEqual({ kind: 'ready' });

    expect(order).toEqual(['persist-active', 'activate']);
  });

  it('types Active pointer failures without publishing the target client', async () => {
    const { adapter, matrix, storage } = setup();
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
      throwError(() => new DOMException('quota', 'QuotaExceededError')),
    );

    await expect(
      firstValueFrom(adapter.commitActiveAccount('@next:hs')),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'local-state-unavailable',
    });
    expect(matrix.setActive).not.toHaveBeenCalled();
  });

  it('keeps a tokenless saved Account visible to reauthentication surfaces', async () => {
    const { adapter, matrix, storage } = setup(null);
    vi.mocked(storage.load).mockReturnValue(of(null));

    await expect(
      firstValueFrom(adapter.restoreAccount('@reauth:hs', 'inactive')),
    ).resolves.toEqual({ kind: 'reauthentication-required' });
    expect(matrix.requireReauthentication).toHaveBeenCalledWith('@reauth:hs');
    expect(matrix.restorePersisted).not.toHaveBeenCalled();
  });

  it('persists, starts in the background, then commits Active placement', async () => {
    const { adapter, matrix, storage } = setup();
    const order: string[] = [];
    vi.mocked(storage.persistForEstablishment).mockReturnValue(
      defer(() => {
        order.push('persist');
        return of(session);
      }),
    );
    vi.mocked(matrix.restorePersisted).mockReturnValue(
      defer(() => {
        order.push('start');
        return of({ kind: 'ready' as const });
      }),
    );
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
      defer(() => {
        order.push('persist-active');
        return of(void 0);
      }),
    );
    vi.mocked(matrix.activateAccount).mockImplementation(() => {
      order.push('activate');
    });

    await expect(
      firstValueFrom(
        adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({ kind: 'ready' });

    expect(order).toEqual(['persist', 'start', 'persist-active', 'activate']);
    expect(storage.persistForEstablishment).toHaveBeenCalledWith(
      session,
      'upsert',
    );
    expect(matrix.restorePersisted).toHaveBeenCalledWith(session, 'background');
    expect(matrix.activateAccount).toHaveBeenCalledWith('@new:hs', 'replace');
  });

  it('keeps inactive placement in the background without changing Active Account', async () => {
    const { adapter, matrix, storage } = setup();
    vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
    vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));

    await expect(
      firstValueFrom(
        adapter.establishAccount(AuthenticatedAccountGrant.issue(session), {
          placement: 'inactive',
          liveAccounts: 'keep',
          accountRecord: 'upsert',
        }),
      ),
    ).resolves.toEqual({ kind: 'ready' });

    expect(storage.setActiveForEstablishment).not.toHaveBeenCalled();
    expect(matrix.activateAccount).not.toHaveBeenCalled();
  });

  it('requires an existing Active Account before inactive placement', async () => {
    const { adapter, matrix, storage } = setup(null);

    await expect(
      firstValueFrom(
        adapter.establishAccount(AuthenticatedAccountGrant.issue(session), {
          placement: 'inactive',
          liveAccounts: 'keep',
          accountRecord: 'upsert',
        }),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'active-account-required',
    });
    expect(storage.persistForEstablishment).not.toHaveBeenCalled();
    expect(matrix.restorePersisted).not.toHaveBeenCalled();
  });

  it('emits expected persistence and startup failures as typed outcomes', async () => {
    const first = setup();
    vi.mocked(first.storage.persistForEstablishment).mockReturnValue(
      throwError(() => new AccountAlreadyStoredError('@new:hs')),
    );

    await expect(
      firstValueFrom(
        first.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'account-already-stored',
    });

    TestBed.resetTestingModule();
    const second = setup();
    vi.mocked(second.storage.persistForEstablishment).mockReturnValue(
      of(session),
    );
    vi.mocked(second.matrix.restorePersisted).mockReturnValue(
      of({ kind: 'failed', failure: 'transient-network' }),
    );

    await expect(
      firstValueFrom(
        second.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'transient-network',
    });
    expect(second.storage.setActiveForEstablishment).not.toHaveBeenCalled();
    expect(second.matrix.activateAccount).not.toHaveBeenCalled();
  });

  it('types recognized storage outages but preserves adapter defects', async () => {
    const first = setup();
    vi.mocked(first.storage.persistForEstablishment).mockReturnValue(
      throwError(() => new DOMException('quota', 'QuotaExceededError')),
    );

    await expect(
      firstValueFrom(
        first.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'local-state-unavailable',
    });

    TestBed.resetTestingModule();
    const second = setup();
    const defect = Object.assign(new Error('broken storage adapter'), {
      code: 'KEYSTORE_INVARIANT_BROKEN',
    });
    vi.mocked(second.storage.persistForEstablishment).mockReturnValue(
      throwError(() => defect),
    );

    await expect(
      firstValueFrom(
        second.adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).rejects.toBe(defect);
  });

  it('rolls back the live Account when Active-pointer persistence fails', async () => {
    const { adapter, matrix, storage } = setup();
    vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
    vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(
      throwError(() => new DOMException('quota', 'QuotaExceededError')),
    );

    await expect(
      firstValueFrom(
        adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed',
      failure: 'local-state-unavailable',
    });
    expect(matrix.activateAccount).not.toHaveBeenCalled();
    expect(matrix.rollbackAccountStart).toHaveBeenCalledWith('@new:hs');
    expect(
      storage.restoreActiveAfterFailedEstablishment,
    ).not.toHaveBeenCalled();
  });

  it('restores the previous Active pointer when live activation throws after persistence', async () => {
    const { adapter, matrix, storage } = setup('@old:hs');
    const defect = new Error('activation invariant failed');
    vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
    vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));
    vi.mocked(storage.restoreActiveAfterFailedEstablishment).mockReturnValue(
      of(void 0),
    );
    vi.mocked(matrix.activateAccount).mockImplementation(() => {
      throw defect;
    });

    await expect(
      firstValueFrom(
        adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).rejects.toBe(defect);
    expect(matrix.rollbackAccountStart).toHaveBeenCalledWith('@new:hs');
    expect(storage.restoreActiveAfterFailedEstablishment).toHaveBeenCalledWith(
      '@old:hs',
    );
  });

  it('does not commit Active placement when the started Account is not live', async () => {
    const { adapter, matrix, storage } = setup();
    vi.mocked(storage.persistForEstablishment).mockReturnValue(of(session));
    vi.mocked(matrix.restorePersisted).mockReturnValue(of({ kind: 'ready' }));
    vi.mocked(matrix.clientFor).mockReturnValue(null);

    await expect(
      firstValueFrom(
        adapter.establishAccount(
          AuthenticatedAccountGrant.issue(session),
          activeIntent,
        ),
      ),
    ).rejects.toThrow(/non-live Account/);
    expect(storage.setActiveForEstablishment).not.toHaveBeenCalled();
    expect(matrix.activateAccount).not.toHaveBeenCalled();
  });

  it('does not inspect or persist the grant before subscription', () => {
    const { adapter, storage } = setup();

    adapter.establishAccount(
      AuthenticatedAccountGrant.issue(session),
      activeIntent,
    );

    expect(storage.persistForEstablishment).not.toHaveBeenCalled();
  });

  it('retries an identical persisted new-Account grant without saving it again', async () => {
    const { adapter, matrix, storage } = setup();
    const stored = { ...session, cryptoPrefix: 'prefix' };
    vi.mocked(storage.persistForEstablishment).mockReturnValue(of(stored));
    vi.mocked(matrix.restorePersisted)
      .mockReturnValueOnce(of({ kind: 'failed', failure: 'transient-network' }))
      .mockReturnValueOnce(of({ kind: 'ready' }));
    vi.mocked(storage.setActiveForEstablishment).mockReturnValue(of(void 0));
    const intent = { ...activeIntent, accountRecord: 'new' } as const;
    await firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue(session),
        intent,
      ),
    );
    await firstValueFrom(
      adapter.establishAccount(
        AuthenticatedAccountGrant.issue({ ...session }),
        intent,
      ),
    );

    expect(storage.persistForEstablishment).toHaveBeenCalledOnce();
    expect(matrix.restorePersisted).toHaveBeenCalledTimes(2);
  });
});
