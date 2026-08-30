import { TestBed } from '@angular/core/testing';
import { HostNotificationPresentationService } from '@trinity/runtime/host';
import { Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  NotificationDestination,
  NotificationIntent,
} from './notification-intent';
import { NotificationPresenterService } from './notification-presenter.service';

const destination: NotificationDestination = {
  accountId: '@me:example.org',
  roomId: '!room:example.org',
  eventId: '$event',
};

const intent: NotificationIntent = {
  id: '@me:example.org $event',
  title: 'Alice · General',
  body: 'Hello',
  tag: '@me:example.org !room:example.org',
  silent: false,
  destination,
};

describe('NotificationPresenterService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps presentation cold and maps only the host presentation contract', async () => {
    const present = vi.fn(() => of({ kind: 'completed' as const }));
    TestBed.configureTestingModule({
      providers: [
        NotificationPresenterService,
        {
          provide: HostNotificationPresentationService,
          useValue: { present, activated: new Subject() },
        },
      ],
    });
    const command = TestBed.inject(NotificationPresenterService).present(
      intent,
    );

    expect(present).not.toHaveBeenCalled();
    await firstValueFrom(command);
    expect(present).toHaveBeenCalledWith({
      title: 'Alice · General',
      body: 'Hello',
      tag: '@me:example.org !room:example.org',
      silent: false,
      destination,
    });
  });

  it('round-trips the host activation as the same typed destination', async () => {
    const activated = new Subject<NotificationDestination>();
    TestBed.configureTestingModule({
      providers: [
        NotificationPresenterService,
        {
          provide: HostNotificationPresentationService,
          useValue: { activated },
        },
      ],
    });
    const result = firstValueFrom(
      TestBed.inject(NotificationPresenterService).activated,
    );

    activated.next(destination);

    await expect(result).resolves.toBe(destination);
  });

  it('preserves a typed host presentation failure', async () => {
    TestBed.configureTestingModule({
      providers: [
        NotificationPresenterService,
        {
          provide: HostNotificationPresentationService,
          useValue: {
            activated: new Subject(),
            present: () =>
              of({
                kind: 'rejected' as const,
                diagnostic: { code: 'notification-presentation-failed' },
              }),
          },
        },
      ],
    });

    await expect(
      firstValueFrom(
        TestBed.inject(NotificationPresenterService).present(intent),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'notification-presentation-failed' },
    });
  });
});
