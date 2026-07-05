import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { MockProvider, ngMocks } from 'ng-mocks';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authGuard } from './auth.guard';
import { MatrixClientService } from '../matrix/matrix-client.service';
import { SessionStorageService } from '@trinity/platform-native';

/** Run the guard inside an injection context (it takes no route/state). */
function run(): Observable<boolean | UrlTree> {
  return TestBed.runInInjectionContext(
    () => authGuard({} as never, {} as never) as Observable<boolean | UrlTree>,
  );
}

describe('authGuard', () => {
  let matrix: MatrixClientService;
  let storage: SessionStorageService;
  let router: Router;
  let loginTree: UrlTree;

  beforeEach(() => {
    loginTree = new UrlTree();
    TestBed.configureTestingModule({
      providers: [
        MockProvider(MatrixClientService, { isInitialized: false }),
        MockProvider(SessionStorageService),
        MockProvider(Router),
      ],
    });
    matrix = TestBed.inject(MatrixClientService);
    storage = TestBed.inject(SessionStorageService);
    router = TestBed.inject(Router);
    vi.mocked(router.createUrlTree).mockReturnValue(loginTree);
  });

  it('allows navigation when the client is already initialized', async () => {
    ngMocks.stubMember(matrix, 'isInitialized', true);
    expect(await firstValueFrom(run())).toBe(true);
    expect(storage.load).not.toHaveBeenCalled(); // no restore needed
  });

  it('restores a stored session and allows navigation', async () => {
    const session = { userId: '@me:hs' };
    vi.mocked(storage.load).mockReturnValue(of(session) as never);
    vi.mocked(matrix.init).mockReturnValue(of(undefined));

    expect(await firstValueFrom(run())).toBe(true);
    expect(matrix.init).toHaveBeenCalledWith(session);
  });

  it('redirects to /login when there is no stored session', async () => {
    vi.mocked(storage.load).mockReturnValue(of(null) as never);
    expect(await firstValueFrom(run())).toBe(loginTree);
    expect(matrix.init).not.toHaveBeenCalled();
  });

  it('redirects to /login when session restore fails', async () => {
    vi.mocked(storage.load).mockReturnValue(of({ userId: '@me:hs' }) as never);
    vi.mocked(matrix.init).mockReturnValue(
      throwError(() => new Error('init boom')),
    );
    expect(await firstValueFrom(run())).toBe(loginTree);
  });
});
