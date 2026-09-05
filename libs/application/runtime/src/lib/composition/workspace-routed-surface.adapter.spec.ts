import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { DefaultUrlSerializer, NavigationEnd, Router } from '@angular/router';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { firstValueFrom, Subject, type Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';

describe('Workspace routed-surface composition adapter', () => {
  const events = new Subject<NavigationEnd>();
  const serializer = new DefaultUrlSerializer();
  const navigateByUrl = vi.fn().mockResolvedValue(true);
  const locationBack = vi.fn();
  let router: { url: string };
  let lifetime: Subscription;

  beforeEach(() => {
    router = { url: '/rooms' };
    navigateByUrl.mockClear();
    locationBack.mockClear();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    window.history.replaceState({ navigationId: 1 }, '', '/');
    TestBed.configureTestingModule({
      providers: [
        WorkspaceRoutedSurfaceAdapter,
        {
          provide: Router,
          useFactory: () => ({
            get url() {
              return router.url;
            },
            events,
            parseUrl: (url: string) => serializer.parse(url),
            navigateByUrl,
          }),
        },
        { provide: Location, useValue: { back: locationBack } },
      ],
    });
  });

  afterEach(() => {
    lifetime?.unsubscribe();
    vi.unstubAllGlobals();
  });

  function build(url: string) {
    router.url = url;
    lifetime = TestBed.inject(WorkspaceRoutedSurfaceAdapter).run().subscribe();
    return TestBed.inject(WorkspaceBackService);
  }

  it('collapses a narrow deep-linked Settings section before leaving Settings', async () => {
    const back = build('/settings/security');

    await expect(firstValueFrom(back.back())).resolves.toMatchObject({
      kind: 'dismissed',
      surface: {
        layer: 'application',
        surface: { kind: 'settings', section: 'security' },
      },
    });
    expect(navigateByUrl).toHaveBeenCalledWith('/settings', {
      replaceUrl: true,
    });
  });

  it('pops a Settings section entered from the narrow directory', async () => {
    const back = build('/settings');
    router.url = '/settings/appearance';
    events.next(
      new NavigationEnd(2, '/settings/appearance', '/settings/appearance'),
    );

    await firstValueFrom(back.back());

    expect(locationBack).toHaveBeenCalledOnce();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('honours a trust deep link return destination', async () => {
    const back = build('/encryption/unlock?returnTo=%2Fsettings%2Fsecurity');

    await firstValueFrom(back.back());

    expect(navigateByUrl).toHaveBeenCalledWith('/settings/security', {
      replaceUrl: true,
    });
  });

  it('uses browser history for a trust route without an explicit return destination', async () => {
    window.history.replaceState({ navigationId: 2 }, '', '/');
    const back = build('/encryption/verify');

    await firstValueFrom(back.back());

    expect(locationBack).toHaveBeenCalledOnce();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('uses the Workspace root for a cold Settings deep link with no history', async () => {
    const back = build('/settings');

    await firstValueFrom(back.back());

    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
    expect(locationBack).not.toHaveBeenCalled();
  });

  it('leaves non-application routes for Room, history, or host fallthrough', async () => {
    const back = build('/rooms');

    await expect(firstValueFrom(back.back())).resolves.toEqual({
      kind: 'unhandled',
    });
  });

  it('publishes and releases Room projection demand across route changes', () => {
    build(`/rooms/${encodeRoomSegment('!room:example.org')}`);
    const adapter = TestBed.inject(WorkspaceRoutedSurfaceAdapter);

    expect(adapter.roomProjectionDemand()).toBe(true);
    expect(adapter.activeRoomId()).toBe('!room:example.org');

    router.url = '/settings/security';
    events.next(
      new NavigationEnd(2, '/settings/security', '/settings/security'),
    );
    expect(adapter.roomProjectionDemand()).toBe(false);
    expect(adapter.activeRoomId()).toBeNull();

    router.url = '/rooms';
    events.next(new NavigationEnd(3, '/rooms', '/rooms'));
    expect(adapter.roomProjectionDemand()).toBe(true);
    expect(adapter.activeRoomId()).toBeNull();

    lifetime.unsubscribe();
    expect(adapter.roomProjectionDemand()).toBe(false);
    expect(adapter.activeRoomId()).toBeNull();
  });

  it('exposes initial Room demand before its route stream starts', () => {
    router.url = `/rooms/${encodeRoomSegment('!room:example.org')}`;

    expect(
      TestBed.inject(WorkspaceRoutedSurfaceAdapter).roomProjectionDemand(),
    ).toBe(true);
    expect(TestBed.inject(WorkspaceRoutedSurfaceAdapter).activeRoomId()).toBe(
      '!room:example.org',
    );
  });

  it('does not expose an invalid Room route segment as an exact Room id', () => {
    build('/rooms/not-an-encoded-room');

    expect(
      TestBed.inject(WorkspaceRoutedSurfaceAdapter).roomProjectionDemand(),
    ).toBe(true);
    expect(
      TestBed.inject(WorkspaceRoutedSurfaceAdapter).activeRoomId(),
    ).toBeNull();
  });

  it('uses the exact selected Space when no child Room is routed', () => {
    build(`/rooms?space=${encodeRoomSegment('!space:example.org')}`);

    expect(TestBed.inject(WorkspaceRoutedSurfaceAdapter).activeRoomId()).toBe(
      '!space:example.org',
    );
  });

  it('rejects a conflicting Space and named view as an administration scope', () => {
    build(`/rooms?view=rooms&space=${encodeRoomSegment('!space:example.org')}`);

    expect(
      TestBed.inject(WorkspaceRoutedSurfaceAdapter).activeRoomId(),
    ).toBeNull();
  });
});
