import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService } from '@trinity/components/overlay';
import { firstValueFrom, isObservable, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { workspaceBrowserBackGuard } from './workspace-browser-back.guard';

function setup(
  trigger: 'imperative' | 'popstate',
  options: {
    readonly active: boolean;
    readonly dialogOpen?: boolean;
    readonly activeOwnsTopmostOverlay?: boolean;
  },
) {
  const back = vi.fn(() => of({ kind: 'dismissed' } as const));
  const closeTopmost = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: Router,
        useValue: { currentNavigation: () => ({ trigger }) },
      },
      {
        provide: WorkspaceBackService,
        useValue: {
          hasActive: () => options.active,
          activeOwnsTopmostOverlay: () =>
            options.activeOwnsTopmostOverlay ?? false,
          back,
        },
      },
      {
        provide: TrnDialogService,
        useValue: {
          hasOpen: () => options.dialogOpen ?? false,
          closeTopmost,
        },
      },
    ],
  });
  const result = TestBed.runInInjectionContext(workspaceBrowserBackGuard);
  return { back, closeTopmost, result };
}

describe('workspaceBrowserBackGuard', () => {
  it('cancels browser history after offering it to the active semantic surface', async () => {
    const { back, result } = setup('popstate', { active: true });

    expect(isObservable(result)).toBe(true);
    expect(await firstValueFrom(result as Observable<boolean>)).toBe(false);
    expect(back).toHaveBeenCalledOnce();
  });

  it('leaves imperative navigation alone', () => {
    expect(setup('imperative', { active: true }).result).toBe(true);
  });

  it('leaves unowned browser history alone', () => {
    expect(setup('popstate', { active: false }).result).toBe(true);
  });

  it('offers an unowned topmost overlay its dismissal guard before Workspace', () => {
    const { back, closeTopmost, result } = setup('popstate', {
      active: true,
      dialogOpen: true,
    });

    expect(result).toBe(false);
    expect(closeTopmost).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
  });

  it('lets the semantic owner handle its own topmost overlay', async () => {
    const { back, closeTopmost, result } = setup('popstate', {
      active: true,
      dialogOpen: true,
      activeOwnsTopmostOverlay: true,
    });

    expect(await firstValueFrom(result as Observable<boolean>)).toBe(false);
    expect(back).toHaveBeenCalledOnce();
    expect(closeTopmost).not.toHaveBeenCalled();
  });
});
