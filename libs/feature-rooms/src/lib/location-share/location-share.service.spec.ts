import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnToastService } from '@trinity/helm/overlay';
import { TimelineService } from '@trinity/data-access-timeline';
import { GeolocationService } from '@trinity/platform-native';
import { LocationShareService } from './location-share.service';

function setup(
  over: {
    current?: ReturnType<typeof vi.fn>;
    sendLocation?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const current = over.current ?? vi.fn(() => of({ lat: 1.5, lng: 2.5 }));
  const sendLocation = over.sendLocation ?? vi.fn(() => of(undefined));
  const toastShow = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      LocationShareService,
      MockProvider(GeolocationService, { current }),
      MockProvider(TimelineService, { sendLocation }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    svc: TestBed.inject(LocationShareService),
    current,
    sendLocation,
    toastShow,
  };
}

describe('LocationShareService', () => {
  it('resolves the location and sends it to the active room', () => {
    const { svc, current, sendLocation } = setup();

    svc.share();

    expect(current).toHaveBeenCalled();
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
});
