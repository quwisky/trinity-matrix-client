import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { GeolocationService } from '@trinity/platform-native';
import { LocationShareService } from './location-share.service';

interface Bridge {
  isElectron?: boolean;
}

function setBridge(bridge: Bridge | undefined): void {
  (globalThis as { trinityDesktop?: Bridge }).trinityDesktop = bridge;
}

function setup(
  over: {
    current?: Mock;
    sendLocation?: Mock;
    openAndWait?: Mock;
  } = {},
) {
  const current = over.current ?? vi.fn(() => of({ lat: 1.5, lng: 2.5 }));
  const sendLocation = over.sendLocation ?? vi.fn(() => of(undefined));
  const openAndWait =
    over.openAndWait ?? vi.fn(() => Promise.resolve({ lat: 3.5, lng: 4.5 }));
  const toastShow = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      LocationShareService,
      MockProvider(GeolocationService, { current }),
      MockProvider(TimelineActionsService, { sendLocation }),
      MockProvider(TrnDialogService, { openAndWait }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    svc: TestBed.inject(LocationShareService),
    current,
    sendLocation,
    openAndWait,
    toastShow,
  };
}

describe('LocationShareService', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: Bridge }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  describe('web / mobile (device geolocation)', () => {
    it('resolves the location and sends it to the active room', () => {
      const { svc, current, sendLocation, openAndWait } = setup();

      svc.share();

      expect(current).toHaveBeenCalled();
      expect(openAndWait).not.toHaveBeenCalled();
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
        expect.objectContaining({ variant: 'destructive' }),
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

  describe('desktop (manual dialog)', () => {
    it('sends the native desktop location without opening the dialog', async () => {
      setBridge({ isElectron: true });
      const { svc, current, openAndWait, sendLocation } = setup();

      svc.share();
      await Promise.resolve();

      expect(current).toHaveBeenCalled();
      expect(openAndWait).not.toHaveBeenCalled();
      expect(sendLocation).toHaveBeenCalledWith(1.5, 2.5);
    });

    it('falls back to the manual dialog when native location fails', async () => {
      setBridge({ isElectron: true });
      const current = vi.fn(() => throwError(() => new Error('denied')));
      const { svc, openAndWait, sendLocation, toastShow } = setup({ current });

      svc.share();
      await Promise.resolve();
      await Promise.resolve();

      expect(openAndWait).toHaveBeenCalled();
      expect(sendLocation).toHaveBeenCalledWith(3.5, 4.5);
      expect(toastShow).not.toHaveBeenCalled();
    });

    it('sends nothing when native location fails and the dialog is dismissed', async () => {
      setBridge({ isElectron: true });
      const current = vi.fn(() => throwError(() => new Error('denied')));
      const openAndWait = vi.fn(() => Promise.resolve(null));
      const { svc, sendLocation } = setup({ current, openAndWait });

      svc.share();
      await Promise.resolve();
      await Promise.resolve();

      expect(sendLocation).not.toHaveBeenCalled();
      expect(svc.sharing()).toBe(false);
    });
  });
});
