import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  EventType,
  MatrixEvent,
  RelationType,
  SyncState,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { HostNotificationPresentationService } from '@trinity/runtime/host';
import { NotificationPolicy } from './notification-policy';
import { NotificationService } from './notification.service';
import { ReactionNotificationSettingsService } from './reaction-notification-settings.service';
import { RoomNotificationsService } from './room-notifications.service';
import { NotificationSoundService } from './notification-sound.service';
import { NOTIFICATION_VISIBILITY } from './notification-visibility.port';

const ACCOUNT = '@me:hs';
const ROOM = '!room:hs';
const TARGET = '$target';

function target(sender = ACCOUNT): MatrixEvent {
  return new MatrixEvent({
    event_id: TARGET,
    room_id: ROOM,
    sender,
    type: EventType.RoomMessage,
    content: { msgtype: 'm.text', body: 'Original message' },
  });
}

function reaction(id: string, sender = '@alice:hs', key = '👍'): MatrixEvent {
  return new MatrixEvent({
    event_id: id,
    room_id: ROOM,
    sender,
    type: EventType.Reaction,
    content: {
      'm.relates_to': {
        rel_type: RelationType.Annotation,
        event_id: TARGET,
        key,
      },
    },
  });
}

describe('reaction notifications integration', () => {
  let client: ReturnType<typeof setupClient>;
  let present: ReturnType<typeof vi.fn>;
  let settings: { isOn: ReturnType<typeof vi.fn> };
  let rooms: { modeFor: ReturnType<typeof vi.fn> };
  let sound: { isOn: ReturnType<typeof vi.fn> };
  let visibility: { snapshot: ReturnType<typeof vi.fn> };
  let handlers: Map<string, (...args: unknown[]) => void>;
  let owner: { unsubscribe(): void };
  let service: NotificationService;
  let accountIds: ReturnType<typeof signal<readonly string[]>>;
  let clients: Map<string, ReturnType<typeof setupClient>>;
  let activation: Subject<{
    accountId: string;
    roomId: string;
    eventId: string;
  }>;

  function setupClient(userId = ACCOUNT) {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const events = new Map([[TARGET, target(userId)]]);
    const value = {
      getUserId: () => userId,
      getSyncState: vi.fn(() => SyncState.Prepared),
      getRoom: () => room,
      getPushActionsForEvent: vi.fn(() => ({ notify: true, tweaks: {} })),
      getAccountData: () => undefined,
      pushRules: {
        global: { override: [{ rule_id: '.m.rule.master', enabled: false }] },
      },
      isUserIgnored: vi.fn(() => false),
      on: vi.fn((kind: string, handler: (...args: unknown[]) => void) =>
        listeners.set(kind, handler),
      ),
      off: vi.fn(),
      fetchRoomEvent: vi.fn(async () => events.get(TARGET)!.event),
      findEventById: (id: string) => events.get(id),
      getEventMapper: vi.fn(
        () => (raw: MatrixEvent['event']) => new MatrixEvent(raw),
      ),
      decryptEventIfNeeded: vi.fn(async () => undefined),
      listeners,
    };
    return value;
  }

  const room = {
    roomId: ROOM,
    name: 'General',
    findEventById: (id: string) => client.findEventById(id),
    getMember: (id: string) => ({ name: id === '@alice:hs' ? 'Alice' : id }),
  } as unknown as Room;

  beforeEach(() => {
    vi.useFakeTimers();
    client = setupClient();
    handlers = client.listeners as Map<string, (...args: unknown[]) => void>;
    present = vi.fn(() => of({ kind: 'completed' as const }));
    settings = { isOn: vi.fn(() => false) };
    rooms = { modeFor: vi.fn(() => 'all') };
    sound = { isOn: vi.fn(() => true) };
    visibility = {
      snapshot: vi.fn(() => ({ foreground: false, conversation: null })),
    };
    accountIds = signal<readonly string[]>([ACCOUNT]);
    clients = new Map([[ACCOUNT, client]]);
    activation = new Subject();
    TestBed.configureTestingModule({
      providers: [
        NotificationService,
        NotificationPolicy,
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            accountIds: accountIds.asReadonly(),
            clientFor: (id: string) =>
              clients.get(id) as unknown as MatrixClient,
            instance: client,
          },
        },
        { provide: ReactionNotificationSettingsService, useValue: settings },
        { provide: RoomNotificationsService, useValue: rooms },
        { provide: NotificationSoundService, useValue: sound },
        { provide: NOTIFICATION_VISIBILITY, useValue: visibility },
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

  function emit(event: MatrixEvent, liveEvent = true): void {
    (
      handlers.get('Room.timeline') as
        | ((
            event: MatrixEvent,
            room: Room,
            toStart?: boolean,
            removed?: boolean,
            data?: unknown,
          ) => void)
        | undefined
    )?.(event, room, false, false, { liveEvent });
  }

  it('keeps the opt-in disabled by default and presents an enabled grouped reaction', async () => {
    emit(reaction('$off'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).not.toHaveBeenCalled();

    settings.isOn.mockReturnValue(true);
    emit(reaction('$one'));
    emit(reaction('$two', '@bob:hs', '✅'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Alice and 1 other reacted 👍 ✅ · General',
        body: 'Your message: Original message',
        silent: false,
        destination: { accountId: ACCOUNT, roomId: ROOM, eventId: TARGET },
      }),
    );
  });

  it.each([
    [
      'master disabled',
      () => {
        client.pushRules.global.override[0].enabled = true;
      },
    ],
    ['room muted', () => rooms.modeFor.mockReturnValue('mute')],
    ['sender ignored', () => client.isUserIgnored.mockReturnValue(true)],
  ])(
    'honors %s while still allowing mentions-only rooms',
    async (_label, change) => {
      settings.isOn.mockReturnValue(true);
      change();
      emit(reaction('$blocked'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(present).not.toHaveBeenCalled();

      client.pushRules.global.override[0].enabled = false;
      rooms.modeFor.mockReturnValue('mentions');
      client.isUserIgnored.mockReturnValue(false);
      emit(reaction('$allowed'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(present).toHaveBeenCalledTimes(1);
    },
  );

  it('suppresses visible reactions and respects sound', async () => {
    settings.isOn.mockReturnValue(true);
    visibility.snapshot.mockReturnValue({
      foreground: true,
      conversation: { accountId: ACCOUNT, roomId: ROOM },
    });
    emit(reaction('$visible'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).not.toHaveBeenCalled();

    visibility.snapshot.mockReturnValue({
      foreground: false,
      conversation: null,
    });
    sound.isOn.mockReturnValue(false);
    emit(reaction('$sound'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({ silent: true }),
    );
  });

  it('ignores backfill and releases reaction work with the notification session', async () => {
    settings.isOn.mockReturnValue(true);
    emit(reaction('$history'), false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).not.toHaveBeenCalled();
    emit(reaction('$pending'));
    owner.unsubscribe();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(present).not.toHaveBeenCalled();
  });

  it('waits for the first prepared sync and ignores initial live-labelled history', async () => {
    owner.unsubscribe();
    client.getSyncState.mockReturnValue(null as unknown as SyncState);
    owner = service.run().subscribe();
    settings.isOn.mockReturnValue(true);

    emit(reaction('$initial'), true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).not.toHaveBeenCalled();

    client.getSyncState.mockReturnValue(SyncState.Prepared);
    handlers.get(ClientEvent.Sync)?.(SyncState.Prepared);
    emit(reaction('$after-ready'), true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('keeps same event ids isolated across accounts and uses each owning setting', async () => {
    settings.isOn.mockImplementation((id: string) => id === '@other:hs');
    const other = setupClient('@other:hs');
    clients.set('@other:hs', other);
    accountIds.set([ACCOUNT, '@other:hs']);
    await vi.advanceTimersByTimeAsync(0);

    emit(reaction('$me-target'), true);
    const otherTimeline = other.listeners.get('Room.timeline') as
      | ((
          event: MatrixEvent,
          room: Room,
          a?: boolean,
          b?: boolean,
          data?: unknown,
        ) => void)
      | undefined;
    const otherRoom = {
      ...room,
      findEventById: (id: string) => other.findEventById(id),
    } as unknown as Room;
    otherTimeline?.(reaction('$same-id'), otherRoom, false, false, {
      liveEvent: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { accountId: '@other:hs', roomId: ROOM, eventId: TARGET },
      }),
    );

    settings.isOn.mockReturnValue(true);
    const sameReactionId = '$same-id-both-accounts';
    emit(reaction(sameReactionId), true);
    otherTimeline?.(reaction(sameReactionId), otherRoom, false, false, {
      liveEvent: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(present).toHaveBeenCalledTimes(3);
    expect(
      present.mock.calls
        .slice(1)
        .map(([intent]) => intent.destination.accountId),
    ).toEqual(['@me:hs', '@other:hs']);
  });

  it('drops a fetched reaction when the owning client is replaced before reconciliation', async () => {
    settings.isOn.mockReturnValue(true);
    let resolve!: (event: MatrixEvent['event']) => void;
    client.findEventById = () => undefined;
    client.fetchRoomEvent.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    emit(reaction('$replacement'), true);
    await vi.advanceTimersByTimeAsync(2_000);

    const old = client;
    client = setupClient();
    clients.set(ACCOUNT, client);
    resolve(target().event);
    await vi.advanceTimersByTimeAsync(0);
    expect(present).not.toHaveBeenCalled();
    expect(old.fetchRoomEvent).toHaveBeenCalledOnce();
  });

  it('cancels a pending fetch when presentation activation ownership is released', async () => {
    settings.isOn.mockReturnValue(true);
    let resolve!: (event: MatrixEvent['event']) => void;
    client.findEventById = () => undefined;
    client.fetchRoomEvent.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    emit(reaction('$ownership'), true);
    await vi.advanceTimersByTimeAsync(2_000);
    activation.complete();
    resolve(target().event);
    await vi.advanceTimersByTimeAsync(0);
    expect(present).not.toHaveBeenCalled();
    expect(client.off).toHaveBeenCalled();
  });
});
