import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import { MatrixAccountRuntimeAdapter } from './matrix-account-runtime.adapter';

describe('MatrixAccountRuntimeAdapter', () => {
  it('keeps a tokenless saved Account visible to reauthentication surfaces', async () => {
    TestBed.configureTestingModule({
      providers: [
        MatrixAccountRuntimeAdapter,
        MockProvider(MatrixClientService),
        MockProvider(SessionStorageService),
      ],
    });
    const adapter = TestBed.inject(MatrixAccountRuntimeAdapter);
    const matrix = TestBed.inject(MatrixClientService);
    const storage = TestBed.inject(SessionStorageService);
    vi.mocked(storage.load).mockReturnValue(of(null));

    await expect(
      firstValueFrom(adapter.restoreAccount('@reauth:hs', 'inactive')),
    ).resolves.toEqual({ kind: 'reauthentication-required' });
    expect(matrix.requireReauthentication).toHaveBeenCalledWith('@reauth:hs');
    expect(matrix.restorePersisted).not.toHaveBeenCalled();
  });
});
