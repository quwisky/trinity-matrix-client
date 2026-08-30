import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { DefaultUrlSerializer, Router } from '@angular/router';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { firstValueFrom, Subject, type Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRoutedSurfaceAdapter } from './workspace-routed-surface.adapter';

describe('WorkspaceRoutedSurfaceAdapter', () => {
  const events = new Subject<never>();
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
});
