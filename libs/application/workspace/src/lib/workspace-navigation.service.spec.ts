import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_NAVIGATION_ACTIVATOR,
  WorkspaceNavigationService,
  type WorkspaceNavigationActivator,
} from './workspace-navigation.service';
import type { WorkspaceNavigation } from './workspace-navigation.models';

const intent = {
  kind: 'notification',
  accountId: '@alice:example.org',
  roomId: '!room:example.org',
  eventId: '$event',
} as const;

function setup(activator?: WorkspaceNavigationActivator) {
  TestBed.configureTestingModule({
    providers: [
      WorkspaceNavigationService,
      ...(activator
        ? [{ provide: WORKSPACE_NAVIGATION_ACTIVATOR, useValue: activator }]
        : []),
    ],
  });
  return TestBed.inject(WorkspaceNavigationService);
}

afterEach(() => TestBed.resetTestingModule());

describe('WorkspaceNavigationService', () => {
  it('keeps navigation cold and delegates to the registered Workspace', async () => {
    const service = setup();
    const navigate = vi.fn(() =>
      of({ kind: 'ready', change: 'committed' } as const),
    );
    service.register({ navigate });

    const command = service.navigate(intent);

    expect(navigate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'ready',
      change: 'committed',
    });
    expect(navigate).toHaveBeenCalledWith(intent);
  });

  it('activates the Room shell once before delegating when Workspace is absent', async () => {
    const mounted: { service?: WorkspaceNavigationService } = {};
    const navigate = vi.fn(() =>
      of({ kind: 'ready', change: 'committed' } as const),
    );
    const activate = vi.fn(() => {
      mounted.service?.register({ navigate });
      return of({ kind: 'ready' } as const);
    });
    const service = setup({ activate });
    mounted.service = service;

    await expect(firstValueFrom(service.navigate(intent))).resolves.toEqual({
      kind: 'ready',
      change: 'committed',
    });
    expect(activate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(intent);
  });

  it('reports typed unavailability when activation cannot provide Workspace', async () => {
    const service = setup({
      activate: () => of({ kind: 'unavailable' } as const),
    });

    await expect(firstValueFrom(service.navigate(intent))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'navigation-rejected',
    });
  });

  it('removes only the implementation that owns an unregister callback', async () => {
    const service = setup();
    const first: WorkspaceNavigation = {
      navigate: () => of({ kind: 'ready', change: 'unchanged' }),
    };
    const second: WorkspaceNavigation = {
      navigate: () => of({ kind: 'ready', change: 'committed' }),
    };
    const unregisterFirst = service.register(first);
    service.register(second);

    unregisterFirst();

    await expect(firstValueFrom(service.navigate(intent))).resolves.toEqual({
      kind: 'ready',
      change: 'committed',
    });
  });
});
