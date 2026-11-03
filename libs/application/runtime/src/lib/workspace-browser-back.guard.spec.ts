import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { DefaultUrlSerializer, Router } from '@angular/router';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
  type WorkspacePanel,
  type WorkspaceRoomSurface,
} from '@trinity/application/workspace';
import { TrnSurfaceService } from '@trinity/components/overlay';
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
    readonly outcome?: 'dismissed' | 'unhandled';
    readonly conversation?: boolean;
    readonly conversationOverList?: boolean;
    readonly projectingLocation?: boolean;
    /** The active surface is this Room surface. */
    readonly room?: WorkspaceRoomSurface;
    /** The panel Workspace's destination names. */
    readonly panel?: WorkspacePanel;
  },
) {
  const back = vi.fn(() =>
    of({ kind: options.outcome ?? 'dismissed' } as const),
  );
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
            !options.active
              ? null
              : options.room
                ? { layer: 'room', surface: options.room }
                : options.conversation
                  ? {
                      layer: 'conversation',
                      surface: {
                        kind: 'conversation',
                        accountId: '@alice:example.org',
                        roomId: '!room:example.org',
                      },
                    }
                  : {
                      layer: 'application',
                      surface: { kind: 'settings', section: null },
                    },
        },
      },
      {
        provide: WorkspaceNavigationService,
        useValue: {
          projectingLocation: options.projectingLocation ?? false,
          conversationOverList: () => options.conversationOverList ?? false,
          panel: () => options.panel ?? null,
        },
      },
      {
        provide: WorkspaceRoutedSurfaceAdapter,
        useValue: {
          owns: () => options.routedOwnsActive ?? false,
        },
      },
      {
        provide: TrnSurfaceService,
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
          provide: WorkspaceNavigationService,
          useValue: {
            projectingLocation: false,
            conversationOverList: () => false,
          },
        },
        {
          provide: TrnSurfaceService,
          useValue: { hasOpen: () => false, closeTopmost: vi.fn() },
        },
      ],
    });
    const adapter = TestBed.inject(WorkspaceRoutedSurfaceAdapter);
    const lifetime = adapter.run().subscribe();

    expect(TestBed.runInInjectionContext(workspaceBrowserBackGuard)).toBe(true);
    lifetime.unsubscribe();
  });

  it('lets browser history through when no surface handles Back after all', async () => {
    const { back, result } = setup('popstate', {
      active: true,
      outcome: 'unhandled',
    });

    expect(await firstValueFrom(result as Observable<boolean>)).toBe(true);
    expect(back).toHaveBeenCalledOnce();
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

  it("lets Workspace's own history pop land without offering it to any surface", () => {
    const test = setup('popstate', {
      active: true,
      conversation: true,
      projectingLocation: true,
    });

    expect(test.result).toBe(true);
    expect(test.back).not.toHaveBeenCalled();
  });

  it('lets history leave a Conversation pushed over its list (#1113)', () => {
    const test = setup('popstate', {
      active: true,
      conversation: true,
      conversationOverList: true,
    });

    expect(test.result).toBe(true);
    expect(test.back).not.toHaveBeenCalled();
  });

  // A dismissal started here would supersede this popstate and be cancelled with it.
  it('lets history leave a Conversation with no list below, such as one hopped to (#1888)', () => {
    const test = setup('popstate', { active: true, conversation: true });

    expect(test.result).toBe(true);
    expect(test.back).not.toHaveBeenCalled();
  });

  it('still closes an unowned dialog over a Conversation first', () => {
    const test = setup('popstate', {
      active: true,
      conversation: true,
      dialogOpen: true,
    });

    expect(test.result).toBe(false);
    expect(test.closeTopmost).toHaveBeenCalledOnce();
    expect(test.back).not.toHaveBeenCalled();
  });

  describe('a Room panel', () => {
    it('lets history close a panel the URL names, as the step lands on the Room', () => {
      const test = setup('popstate', {
        active: true,
        room: { kind: 'thread', rootEventId: '$root:example.org' },
        panel: { kind: 'thread', root: '$root:example.org' },
      });

      expect(test.result).toBe(true);
      expect(test.back).not.toHaveBeenCalled();
    });

    it('still offers a panel the URL does not name to Workspace', async () => {
      const test = setup('popstate', {
        active: true,
        room: { kind: 'thread', rootEventId: '$other:example.org' },
        panel: { kind: 'thread', root: '$root:example.org' },
      });

      expect(isObservable(test.result)).toBe(true);
      await expect(
        firstValueFrom(test.result as Observable<boolean>),
      ).resolves.toBe(false);
      expect(test.back).toHaveBeenCalledOnce();
    });

    it('still closes an unowned dialog over a URL-backed panel first', () => {
      const test = setup('popstate', {
        active: true,
        dialogOpen: true,
        room: { kind: 'members' },
        panel: { kind: 'members' },
      });

      expect(test.result).toBe(false);
      expect(test.closeTopmost).toHaveBeenCalledOnce();
      expect(test.back).not.toHaveBeenCalled();
    });
  });
});
