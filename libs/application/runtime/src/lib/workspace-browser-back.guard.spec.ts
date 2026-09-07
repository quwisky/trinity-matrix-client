import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { DefaultUrlSerializer, Router } from '@angular/router';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnDialogService } from '@trinity/components/overlay';
import { WorkspaceRoutedSurfaceAdapter } from './composition/workspace-routed-surface.adapter';
import {
  firstValueFrom,
  isObservable,
  of,
  Subject,
  type Observable,
} from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { workspaceBrowserBackGuard } from './workspace-browser-back.guard';

function setup(
  trigger: 'imperative' | 'popstate',
  options: {
    readonly active: boolean;
    readonly dialogOpen?: boolean;
    readonly activeOwnsTopmostOverlay?: boolean;
    readonly routedOwnsActive?: boolean;
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
          activeSurface: () =>
            options.active
              ? {
                  layer: 'application',
                  surface: { kind: 'settings', section: null },
                }
              : null,
        },
      },
      {
        provide: WorkspaceRoutedSurfaceAdapter,
        useValue: {
          owns: () => options.routedOwnsActive ?? false,
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

  it('allows the real routed adapter owner through without consuming Back again', () => {
    const events = new Subject<never>();
    const serializer = new DefaultUrlSerializer();
    TestBed.configureTestingModule({
      providers: [
        WorkspaceRoutedSurfaceAdapter,
        {
          provide: Router,
          useValue: {
            url: '/settings/security',
            events,
            parseUrl: (url: string) => serializer.parse(url),
            currentNavigation: () => ({ trigger: 'popstate' }),
          },
        },
        { provide: Location, useValue: { back: vi.fn() } },
        {
          provide: TrnDialogService,
          useValue: { hasOpen: () => false, closeTopmost: vi.fn() },
        },
      ],
    });
    const adapter = TestBed.inject(WorkspaceRoutedSurfaceAdapter);
    const lifetime = adapter.run().subscribe();

    expect(TestBed.runInInjectionContext(workspaceBrowserBackGuard)).toBe(true);
    lifetime.unsubscribe();
  });

  it('leaves imperative navigation alone', () => {
    expect(setup('imperative', { active: true }).result).toBe(true);
  });

  it('leaves unowned browser history alone', () => {
    expect(setup('popstate', { active: false }).result).toBe(true);
  });

  it('allows popstate through when the routed application owns the active surface', () => {
    const { back, result } = setup('popstate', {
      active: true,
      routedOwnsActive: true,
    });

    expect(result).toBe(true);
    expect(back).not.toHaveBeenCalled();
  });

  it('still lets another semantic owner block routed browser history', async () => {
    const { back, result } = setup('popstate', {
      active: true,
      routedOwnsActive: false,
    });

    expect(await firstValueFrom(result as Observable<boolean>)).toBe(false);
    expect(back).toHaveBeenCalledOnce();
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
      routedOwnsActive: true,
    });

    expect(await firstValueFrom(result as Observable<boolean>)).toBe(false);
    expect(back).toHaveBeenCalledOnce();
    expect(closeTopmost).not.toHaveBeenCalled();
  });
});
