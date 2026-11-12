import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  ConversationRuntime,
  TimelineActionsService,
} from '@trinity/data-access/timeline';
import { GeolocationService } from '@trinity/platform-native';
import { LocationShareService } from './location-share.service';

function setup(
  over: {
    current?: Mock;
    supportsPrecise?: boolean;
    sendLocation?: Mock;
    openAndWait$?: Mock;
  } = {},
) {
  const current = over.current ?? vi.fn(() => of({ lat: 1.5, lng: 2.5 }));
  const sendLocation = over.sendLocation ?? vi.fn(() => of(undefined));
  const openAndWait$ =
    over.openAndWait$ ?? vi.fn(() => of({ lat: 3.5, lng: 4.5 }));
  const toastShow = vi.fn();
  const focused = signal<{ key: { accountId: string; roomId: string } } | null>(
    { key: { accountId: '@me:hs', roomId: '!a:hs' } },
  );
  TestBed.configureTestingModule({
    providers: [
      LocationShareService,
      MockProvider(GeolocationService, {
        current,
        supportsPrecise: () => over.supportsPrecise ?? true,
      }),
      MockProvider(TimelineActionsService, { sendLocation }),
      { provide: ConversationRuntime, useValue: { focused } },
      MockProvider(TrnSurfaceService, { openAndWait$ }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    svc: TestBed.inject(LocationShareService),
    current,
    sendLocation,
    openAndWait$,
    toastShow,
    focused,
  };
}

describe('LocationShareService', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  describe('web / mobile (device geolocation)', () => {
    it('resolves the location and sends it to the active room', () => {
      const { svc, current, sendLocation, openAndWait$ } = setup();

      svc.share();

      expect(current).toHaveBeenCalled();
      expect(openAndWait$).not.toHaveBeenCalled();
      expect(sendLocation).toHaveBeenCalledWith(1.5, 2.5);
    });

    it('toasts when the location can’t be resolved', () => {
      const current = vi.fn(() =>
        throwError(() => new Error('Permission denied.')),
      );
      const { svc, sendLocation, toastShow } = setup({ current });

      svc.share();

      expect(sendLocation).not.toHaveBeenCalled();
      expect(toastShow).toHaveBeenCalledWith(
        'Permission denied.',
        expect.objectContaining({ variant: 'danger' }),
      );
    });

    it('marks sharing busy while the request is in flight, then clears it', () => {
      const location$ = new Subject<{ lat: number; lng: number }>();
      const { svc } = setup({ current: vi.fn(() => location$) });

      expect(svc.sharing()).toBe(false);

      svc.share();
      expect(svc.sharing()).toBe(true); // resolving — the button shows the spinner

      location$.next({ lat: 1.5, lng: 2.5 });
      location$.complete();
      expect(svc.sharing()).toBe(false); // send settled — spinner cleared
    });
  });

  describe('the room changes before the location arrives', () => {
    const LEFT = 'Location not shared: you left the room it was for.';

    it('does not send a device position to the room opened since', () => {
      const location$ = new Subject<{ lat: number; lng: number }>();
      const { svc, sendLocation, toastShow, focused } = setup({
        current: vi.fn(() => location$),
      });

      svc.share();
      focused.set({ key: { accountId: '@me:hs', roomId: '!b:hs' } });
      location$.next({ lat: 1.5, lng: 2.5 });
      location$.complete();

      expect(sendLocation).not.toHaveBeenCalled();
      expect(toastShow).toHaveBeenCalledExactlyOnceWith(
        LEFT,
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(svc.sharing()).toBe(false);
    });

    it('does not send to the same room under another account', () => {
      const location$ = new Subject<{ lat: number; lng: number }>();
      const { svc, sendLocation, focused } = setup({
        current: vi.fn(() => location$),
      });

      svc.share();
      focused.set({ key: { accountId: '@other:hs', roomId: '!a:hs' } });
      location$.next({ lat: 1.5, lng: 2.5 });

      expect(sendLocation).not.toHaveBeenCalled();
    });

    it('does not send a hand-picked point to the room opened since', () => {
      const picked$ = new Subject<{ lat: number; lng: number } | null>();
      const { svc, sendLocation, toastShow, focused } = setup({
        openAndWait$: vi.fn(() => picked$),
        supportsPrecise: false,
      });

      svc.share();
      focused.set({ key: { accountId: '@me:hs', roomId: '!b:hs' } });
      picked$.next({ lat: 3.5, lng: 4.5 });

      expect(sendLocation).not.toHaveBeenCalled();
      expect(toastShow).toHaveBeenCalledExactlyOnceWith(
        LEFT,
        expect.anything(),
      );
    });

    it('still sends when the same room was left and reopened', () => {
      const location$ = new Subject<{ lat: number; lng: number }>();
      const { svc, sendLocation, focused } = setup({
        current: vi.fn(() => location$),
      });

      svc.share();
      focused.set({ key: { accountId: '@me:hs', roomId: '!b:hs' } });
      focused.set({ key: { accountId: '@me:hs', roomId: '!a:hs' } });
      location$.next({ lat: 1.5, lng: 2.5 });

      expect(sendLocation).toHaveBeenCalledWith(1.5, 2.5);
    });
  });

  describe('desktop (manual dialog)', () => {
    it('opens the manual dialog instead of device geolocation', async () => {
      const { svc, current, openAndWait$, sendLocation } = setup({
        supportsPrecise: false,
      });

      svc.share();
      await Promise.resolve();

      expect(current).not.toHaveBeenCalled();
      expect(openAndWait$).toHaveBeenCalled();
      expect(sendLocation).toHaveBeenCalledWith(3.5, 4.5);
    });

    it('sends nothing when the dialog is dismissed', async () => {
      const openAndWait$ = vi.fn(() => of(null));
      const { svc, sendLocation } = setup({
        openAndWait$,
        supportsPrecise: false,
      });

      svc.share();
      await Promise.resolve();

      expect(sendLocation).not.toHaveBeenCalled();
    });
  });
});
