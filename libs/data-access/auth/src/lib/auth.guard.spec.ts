import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { MockProvider, ngMocks } from 'ng-mocks';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authGuard } from './auth.guard';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/** Run the guard inside an injection context (it takes no route/state). */
function run(): Observable<boolean | UrlTree> {
  return TestBed.runInInjectionContext(
    () => authGuard({} as never, {} as never) as Observable<boolean | UrlTree>,
  );
}

describe('authGuard', () => {
  let matrix: MatrixClientService;
  let router: Router;
  let loginTree: UrlTree;

  beforeEach(() => {
    loginTree = new UrlTree();
    TestBed.configureTestingModule({
      providers: [
        MockProvider(MatrixClientService, { isInitialized: false }),
        MockProvider(Router),
      ],
    });
    matrix = TestBed.inject(MatrixClientService);
    router = TestBed.inject(Router);
    vi.mocked(router.createUrlTree).mockReturnValue(loginTree);
  });

  it('allows navigation when the client is already initialized', async () => {
    ngMocks.stubMember(matrix, 'isInitialized', true);
    expect(await firstValueFrom(run())).toBe(true);
    expect(matrix.restoreAll).not.toHaveBeenCalled(); // no restore needed
  });

  it('restores the stored accounts and allows navigation', async () => {
    vi.mocked(matrix.restoreAll).mockReturnValue(of(true));
    expect(await firstValueFrom(run())).toBe(true);
    expect(matrix.restoreAll).toHaveBeenCalled();
  });

  it('redirects to /login when nothing is stored', async () => {
    vi.mocked(matrix.restoreAll).mockReturnValue(of(false));
    expect(await firstValueFrom(run())).toBe(loginTree);
  });

  it('redirects to /login when restore fails', async () => {
    vi.mocked(matrix.restoreAll).mockReturnValue(
      throwError(() => new Error('restore boom')),
    );
    expect(await firstValueFrom(run())).toBe(loginTree);
  });
});
