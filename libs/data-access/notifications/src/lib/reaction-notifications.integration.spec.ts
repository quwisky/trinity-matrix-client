import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { HostNotificationPresentationService } from '@trinity/runtime/host';
import { type EngineResult, engineOk } from '@trinity/util/matrix';
import { FakeNotificationEngine } from '../contract/fake-notification-engine';
import type { ReactionTarget } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationPolicy } from './notification-policy';
import { NotificationSettingsStore } from './notification-settings.store';
import { NotificationService } from './notification.service';
import { PushService } from './push.service';
import { ReactionNotificationSettingsService } from './reaction-notification-settings.service';
import { RoomNotificationsService } from './room-notifications.service';
import { NotificationSoundService } from './notification-sound.service';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';

const ACCOUNT = '@me:hs';
const OTHER = '@other:hs';

function status(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

describe('reaction notifications integration', () => {
  let engine: FakeNotificationEngine;
  let room: string;
  let target: string;
  let present: ReturnType<typeof vi.fn>;
  let settings: { isOn: ReturnType<typeof vi.fn> };
  let rooms: { modeFor: ReturnType<typeof vi.fn> };
  let sound: { isOn: ReturnType<typeof vi.fn> };
  let master: boolean;
  let visibility: { snapshot: ReturnType<typeof vi.fn> };
  let owner: { unsubscribe(): void };
  let service: NotificationService;
  let backgroundDelivery: ReturnType<typeof signal<'app' | 'push'>>;
  let session: ReturnType<typeof signal<SessionSnapshot>>;
  let activation: Subject<{
    accountId: string;
    roomId: string;
    eventId: string;
  }>;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new FakeNotificationEngine();
    engine.live.add(ACCOUNT);
    room = engine.createRoom('General');
    target = engine.send(ACCOUNT, room, 'Original message');
    present = vi.fn(() => of({ kind: 'completed' as const }));
    settings = { isOn: vi.fn(() => false) };
    rooms = { modeFor: vi.fn(() => 'all') };
    sound = { isOn: vi.fn(() => true) };
    master = false;
    visibility = {
      snapshot: vi.fn(() => ({
        foreground: false,
        hidden: false,
        conversation: null,
      })),
    };
    backgroundDelivery = signal<'app' | 'push'>('app');
    session = signal<SessionSnapshot>({
      ...EMPTY_SESSION,
      activeAccountId: ACCOUNT,
      accounts: [status(ACCOUNT)],
    });
    activation = new Subject();
    TestBed.configureTestingModule({
      providers: [
        NotificationService,
        NotificationPolicy,
        { provide: NOTIFICATION_ENGINE, useValue: engine },
        { provide: SESSION_SNAPSHOT, useValue: session },
        {
          provide: NotificationSettingsStore,
          useValue: {
            settings: () => ({
              defaultRules: [
                { ruleId: '.m.rule.master', kind: 'override', enabled: master },
              ],
            }),
          },
        },
        { provide: ReactionNotificationSettingsService, useValue: settings },
        { provide: RoomNotificationsService, useValue: rooms },
        { provide: NotificationSoundService, useValue: sound },
        { provide: NOTIFICATION_VISIBILITY, useValue: visibility },
        {
          provide: PushService,
          useValue: { backgroundDelivery: backgroundDelivery.asReadonly() },
        },
        {
          provide: HostNotificationPresentationService,
          useValue: {
            support: () => of({ kind: 'supported' as const }),
            activated: activation,
            requestPermission: () => of({ kind: 'completed' as const }),
            present,
          },
        },
      ],
    });
    service = TestBed.inject(NotificationService);
    owner = service.run().subscribe();
  });

  afterEach(() => {
    owner.unsubscribe();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  const react = (sender = '@alice:hs', key = '👍', on = target): string =>
    engine.react(sender, room, on, key);

  /** Holds the account's next target lookup until the returned subject emits. */
  function holdLookup(): Subject<EngineResult<ReactionTarget | null>> {
    const held = new Subject<EngineResult<ReactionTarget | null>>();
    vi.spyOn(engine, 'reactionTarget').mockReturnValueOnce(held);
    return held;
  }

  it('keeps the opt-in disabled by default and presents an enabled grouped reaction', async () => {
    react('@alice:hs');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).not.toHaveBeenCalled();

    settings.isOn.mockReturnValue(true);
    react('@alice:hs');
    react('@bob:hs', '✅');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'alice and 1 other reacted 👍 ✅ · General',
        body: 'Your message: Original message',
        silent: false,
        destination: { accountId: ACCOUNT, roomId: room, eventId: target },
      }),
    );
  });

  it.each([
    ['master disabled', () => (master = true)],
    ['room muted', () => rooms.modeFor.mockReturnValue('mute')],
  ])(
    'honors %s while still allowing mentions-only rooms',
    async (_label, change) => {
      settings.isOn.mockReturnValue(true);
      change();
      react();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(present).not.toHaveBeenCalled();

      master = false;
      rooms.modeFor.mockReturnValue('mentions');
      react();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(present).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps presenting reactions while hidden when push owns the background', async () => {
    settings.isOn.mockReturnValue(true);
    backgroundDelivery.set('push');
    visibility.snapshot.mockReturnValue({
      foreground: false,
      hidden: true,
      conversation: null,
    });
    react();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('suppresses visible reactions and respects sound', async () => {
    settings.isOn.mockReturnValue(true);
    visibility.snapshot.mockReturnValue({
      foreground: true,
      hidden: false,
      conversation: { accountId: ACCOUNT, roomId: room },
    });
    react();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).not.toHaveBeenCalled();

    visibility.snapshot.mockReturnValue({
      foreground: false,
      hidden: false,
      conversation: null,
    });
    sound.isOn.mockReturnValue(false);
    react();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ silent: true }),
    );
  });

  it('releases reaction work with the notification session', async () => {
    settings.isOn.mockReturnValue(true);
    react();
    owner.unsubscribe();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(present).not.toHaveBeenCalled();
    expect(engine.feeds(ACCOUNT)).toBe(0);
  });

  it('keeps same event ids isolated across accounts and uses each owning setting', async () => {
    settings.isOn.mockImplementation((id: string) => id === OTHER);
    engine.live.add(OTHER);
    const otherTarget = engine.send(OTHER, room, 'Other message');
    present.mockClear(); // The message itself notified @me.
    session.update((current) => ({
      ...current,
      accounts: [status(ACCOUNT), status(OTHER)],
    }));
    await vi.advanceTimersByTimeAsync(0);
    const annotation = (accountId: string, eventId: string, on: string) =>
      engine.deliver({
        kind: 'reaction-annotation',
        accountId,
        roomId: room,
        roomName: 'General',
        eventId,
        targetEventId: on,
        key: '👍',
        senderId: '@alice:hs',
        senderName: 'Alice',
      });

    annotation(ACCOUNT, '$me-only', target);
    annotation(OTHER, '$same-id', otherTarget);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { accountId: OTHER, roomId: room, eventId: otherTarget },
      }),
    );

    settings.isOn.mockReturnValue(true);
    annotation(ACCOUNT, '$same-id-both-accounts', target);
    annotation(OTHER, '$same-id-both-accounts', otherTarget);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(present).toHaveBeenCalledTimes(3);
    expect(
      present.mock.calls
        .slice(1)
        .map(([intent]) => intent.destination.accountId),
    ).toEqual([ACCOUNT, OTHER]);
  });

  it.each([
    ['presents', 1, 1],
    ['drops', 2, 0],
  ])(
    '%s a looked-up reaction by session generation, before reconciliation',
    async (_label, generation, presented) => {
      settings.isOn.mockReturnValue(true);
      const held = holdLookup();
      const reaction = react();
      await vi.advanceTimersByTimeAsync(2_000);

      session.update((current) => ({
        ...current,
        accounts: [status(ACCOUNT, generation)],
      }));
      held.next(
        engineOk({ body: 'Original message', liveReactionIds: [reaction] }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(present).toHaveBeenCalledTimes(presented);
    },
  );

  it('cancels a pending lookup when presentation activation ownership is released', async () => {
    settings.isOn.mockReturnValue(true);
    const held = holdLookup();
    react();
    await vi.advanceTimersByTimeAsync(2_000);
    activation.complete();
    expect(held.observed).toBe(false);
    expect(present).not.toHaveBeenCalled();
    expect(engine.feeds(ACCOUNT)).toBe(0);
  });
});
