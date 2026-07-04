import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authGuard } from './auth.guard';
import { MatrixClientService } from '../matrix/matrix-client.service';
import { SessionStorageService } from '../storage/session-storage.service';

/** Run the guard inside an injection context (it takes no route/state). */
function run(): Observable<boolean | UrlTree> {
  return TestBed.runInInjectionContext(
    () => authGuard({} as never, {} as never) as Observable<boolean | UrlTree>,
  );
}

describe('authGuard', () => {
  let matrix: { isInitialized: boolean; init: ReturnType<typeof vi.fn> };
  let storage: { load: ReturnType<typeof vi.fn> };
  let loginTree: UrlTree;

  beforeEach(() => {
    matrix = { isInitialized: false, init: vi.fn() };
    storage = { load: vi.fn() };
    loginTree = new UrlTree();
    TestBed.configureTestingModule({
      providers: [
        { provide: MatrixClientService, useValue: matrix },
        { provide: SessionStorageService, useValue: storage },
        {
          provide: Router,
          useValue: { createUrlTree: vi.fn(() => loginTree) },
        },
      ],
    });
  });

  it('allows navigation when the client is already initialized', async () => {
    matrix.isInitialized = true;
    expect(await firstValueFrom(run())).toBe(true);
    expect(storage.load).not.toHaveBeenCalled(); // no restore needed
  });

  it('restores a stored session and allows navigation', async () => {
    const session = { userId: '@me:hs' };
    storage.load.mockReturnValue(of(session));
    matrix.init.mockReturnValue(of(undefined));

    expect(await firstValueFrom(run())).toBe(true);
    expect(matrix.init).toHaveBeenCalledWith(session);
  });

  it('redirects to /login when there is no stored session', async () => {
    storage.load.mockReturnValue(of(null));
    expect(await firstValueFrom(run())).toBe(loginTree);
    expect(matrix.init).not.toHaveBeenCalled();
  });

  it('redirects to /login when session restore fails', async () => {
    storage.load.mockReturnValue(of({ userId: '@me:hs' }));
    matrix.init.mockReturnValue(throwError(() => new Error('init boom')));
    expect(await firstValueFrom(run())).toBe(loginTree);
  });
});
