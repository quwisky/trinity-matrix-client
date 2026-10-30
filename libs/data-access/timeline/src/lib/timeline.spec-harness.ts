// Shared TestBed scaffolding for the timeline specs.
//
// TimelineService (the open-room projection) and TimelineActionsService (the write
// surface) are two services over the SAME fake room + client, so their specs need the
// same doubles. This holds them so neither file owns a private copy that can drift.
//
// The fake client reaches TimelineService through the real js-sdk timeline engine and
// TimelineStores: MatrixClientService doubles as JS_SDK_CLIENTS, and the session is stubbed
// with the client's account live.
import { signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { vi } from 'vitest';
import { TimelineService } from './timeline.service';
import { TimelineActionsService } from './timeline-actions.service';
import { ConversationActionContextService } from './conversation-action-context.service';
import { CONVERSATION_MESSAGE_POLICY } from './conversation-message-adapter.service';
import type { ConversationKey } from './conversation-messages';
import {
  EMPTY_SESSION,
  MatrixClientService,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { MediaService, type UploadedMedia } from '@trinity/data-access/media';
import {
  PrivacySettingsService,
  SystemLineSettingsService,
} from '@trinity/platform-native';

/** A PrivacySettingsService mock with a fixed send-read-receipts preference. */
export function privacyProvider(sendReadReceipts: boolean) {
  return MockProvider(PrivacySettingsService, {
    sendReadReceipts: signal(sendReadReceipts).asReadonly(),
  });
}

/**
 * A SystemLineSettingsService mock with writable category toggles, so a test can hide a
 * category (and flip it back) the way Settings → Appearance does.
 */
export function systemLinesProvider(
  shown: {
    membership?: boolean;
    profile?: boolean;
    room?: boolean;
  } = {},
) {
  const membership = signal(shown.membership ?? true);
  const profile = signal(shown.profile ?? true);
  const roomChanges = signal(shown.room ?? true);
  return {
    provider: MockProvider(SystemLineSettingsService, {
      showMembership: membership.asReadonly(),
      showProfile: profile.asReadonly(),
      showRoomChanges: roomChanges.asReadonly(),
    }),
    membership,
    profile,
    roomChanges,
  };
}

/** A MediaService mock whose uploadMedia echoes a descriptor for the room's mode. */
export function mediaProvider() {
  return MockProvider(MediaService, {
    uploadMedia: (_file: File, encrypt: boolean) =>
      of<UploadedMedia>(
        encrypt
          ? {
              msgtype: 'm.image',
              body: 'pic.png',
              mxc: null,
              file: {
                url: 'mxc://hs/enc',
                v: 'v2',
                key: {} as JsonWebKey,
                iv: 'iv',
                hashes: { sha256: 'h' },
              },
              info: { mimetype: 'image/png', size: 4 },
            }
          : {
              msgtype: 'm.image',
              body: 'pic.png',
              mxc: 'mxc://hs/up',
              file: null,
              info: { mimetype: 'image/png', size: 4 },
            },
      ),
  });
}

/** The account every fake client signs in as, and the room the harness opens. */
export const ROOM_KEY: ConversationKey = {
  accountId: '@me:hs',
  roomId: '!r:hs',
};

/**
 * A session with `accountIds` live, for the timeline stores to follow. `publish` replaces
 * the live accounts, as a sign-out or a restart does.
 */
export function liveSession(accountIds: readonly string[]) {
  const live = (ids: readonly string[], generation = 1): SessionSnapshot => ({
    ...EMPTY_SESSION,
    accounts: ids.map((accountId) => ({
      accountId,
      deviceId: 'DEVICE',
      generation,
      syncState: 'syncing' as const,
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    })),
  });
  const snapshot = signal(live(accountIds));
  const session$ = new Subject<SessionSnapshot>();
  return {
    providers: [
      { provide: SESSION_SNAPSHOT, useValue: snapshot.asReadonly() },
      { provide: SESSION_ENGINE, useValue: { session: () => session$ } },
    ] satisfies Provider[],
    publish(ids: readonly string[], generation = 1): void {
      snapshot.set(live(ids, generation));
      session$.next(snapshot());
    },
  };
}

/**
 * Wrap a fake matrix-js-sdk client as a MatrixClientService mock (and so JS_SDK_CLIENTS),
 * with its account live in the session.
 */
export function matrixProvider(client: unknown) {
  const userId =
    (client as { getUserId?: () => string | null }).getUserId?.() ?? null;
  return [
    MockProvider(MatrixClientService, {
      clientFor: (accountId: string) => (userId === accountId ? client : null),
    } as Partial<MatrixClientService>),
    ...liveSession(userId ? [userId] : []).providers,
  ];
}

/** Appended to the body of an edit {@link fakeEvent} fills in. */
export const EDITED_MARK = ' (as edited)';

/**
 * The edit a fake event reports as its replacement: settled, and in the clear unless told
 * otherwise. Pass it as `replacement` to give a test an edit of the opposite kind.
 */
export function fakeEdit(id: string, encrypted = false) {
  return {
    getId: () => `${id}~edit`,
    isEncrypted: () => encrypted,
    // Settled: an encrypted edit has been decrypted.
    getClearContent: () => (encrypted ? {} : null),
    isDecryptionFailure: () => false,
    isRedacted: () => false,
    isState: () => false,
    status: null,
  };
}

export function fakeEvent(o: {
  id: string;
  sender: string;
  type?: string;
  body?: string;
  msgtype?: string;
  format?: string;
  formattedBody?: string;
  ts?: number;
  redacted?: boolean;
  decryptFail?: boolean;
  encrypted?: boolean;
  status?: string;
  edited?: boolean;
  /** The event `replacingEvent()` returns; `edited` alone gives a {@link fakeEdit}. */
  replacement?: ReturnType<typeof fakeEdit> & Record<string, unknown>;
  editRelation?: boolean;
  replyTo?: string;
  url?: string;
  filename?: string;
  file?: unknown;
  info?: Record<string, unknown>;
  relatesTo?: unknown;
  voice?: boolean;
  waveform?: number[];
  durationMs?: number;
  state?: boolean;
  stateKey?: string;
  content?: Record<string, unknown>;
  prevContent?: Record<string, unknown>;
}) {
  const type = o.type ?? 'm.room.message';
  // Read on every call: a test may change `o` after building the event.
  const content = (): Record<string, unknown> =>
    o.content ?? {
      body: o.body ?? '',
      msgtype: o.msgtype ?? 'm.text',
      format: o.format,
      formatted_body: o.formattedBody,
      // Media fields are only included when supplied, so non-media events keep
      // their previous content shape exactly.
      ...(o.url !== undefined ? { url: o.url } : {}),
      ...(o.filename !== undefined ? { filename: o.filename } : {}),
      ...(o.file !== undefined ? { file: o.file } : {}),
      ...(o.info !== undefined ? { info: o.info } : {}),
      ...(o.relatesTo !== undefined ? { 'm.relates_to': o.relatesTo } : {}),
      ...(o.voice ? { 'org.matrix.msc3245.voice': {} } : {}),
      ...(o.voice || o.waveform || o.durationMs !== undefined
        ? {
            'org.matrix.msc1767.audio': {
              ...(o.durationMs !== undefined ? { duration: o.durationMs } : {}),
              ...(o.waveform !== undefined ? { waveform: o.waveform } : {}),
            },
          }
        : {}),
    };
  // What a filled-in edit says: the event's content under a marked body, so a test can
  // tell the edit's text from the event's own.
  const editedContent = () => ({
    ...content(),
    body: `${String(content()['body'] ?? '')}${EDITED_MARK}`,
  });
  let autoEdit: ReturnType<typeof fakeEdit> | undefined;
  // A valid edit of this event in whatever parts the test left out. Filled in place so
  // `replacingEvent()` keeps returning the test's own object.
  const replacement = () => {
    const given =
      o.replacement ??
      (o.edited ? (autoEdit ??= fakeEdit(o.id, o.encrypted)) : null);
    return (
      given &&
      Object.assign(given, {
        getSender: () => o.sender,
        getType: () => type,
        getRelation: () => ({ rel_type: 'm.replace', event_id: o.id }),
        getContent: () => ({ 'm.new_content': editedContent() }),
        getOriginalContent: () => ({ 'm.new_content': editedContent() }),
        ...given,
      })
    );
  };
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    replyEventId: o.replyTo,
    getRoomId: () => '!r:hs',
    getType: () => type,
    getTs: () => o.ts ?? 0,
    isState: () => o.state ?? o.stateKey !== undefined,
    getStateKey: () => o.stateKey,
    getPrevContent: () => o.prevContent ?? {},
    // As the SDK does: an attached edit's m.new_content, checked or not.
    getContent: () => {
      const edit = replacement();
      return edit ? (edit.getContent()['m.new_content'] ?? {}) : content();
    },
    getOriginalContent: content,
    // As the SDK reads it: the event's own relation, when it has a type and a target.
    getRelation: () => {
      const r = content()['m.relates_to'] as
        Record<string, unknown> | undefined;
      return r?.['rel_type'] && r['event_id'] ? r : null;
    },
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
    isEncrypted: () => o.encrypted ?? false,
    // Settled: an encrypted event has been decrypted.
    getClearContent: () => (o.encrypted ? content() : null),
    isRelation: (relType?: string) =>
      o.editRelation === true &&
      (relType === undefined || relType === 'm.replace'),
    replacingEvent: replacement,
    status: o.status ?? null,
  };
}

export function fakeReaction(sender: string, id = '$re', redacted = false) {
  return {
    getSender: () => sender,
    getId: () => id,
    isRedacted: () => redacted,
  };
}

export function fakeRelations(
  annotations: [string, Set<ReturnType<typeof fakeReaction>>][],
) {
  return { getSortedAnnotationsByKey: () => annotations };
}

/** A room member as the room reports it. */
export function fakeMember(userId: string, typing: boolean, name = userId) {
  return { userId, typing, name, roomId: '!r:hs' };
}

export function fakeRoom(
  events: ReturnType<typeof fakeEvent>[],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
  encrypted = false,
  members: ReturnType<typeof fakeMember>[] = [],
  fullyReadEventId: string | null = null,
  receiptsByEvent: Record<string, string[]> = {},
  power: { mine?: number; redact?: number; send?: number } = {},
) {
  const myPower = power.mine ?? 0;
  const redactLevel = power.redact ?? 50;
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    roomId: '!r:hs',
    // Room state hangs off the live timeline (what liveRoomState() reads, and what
    // the SDK's deprecated `currentState` aliased).
    loadMembersIfNeeded: () => Promise.resolve(true),
    getLiveTimeline: () => ({
      getEvents: () => events,
      getPaginationToken: () => null,
      getState: () => ({
        hasSufficientPowerLevelFor: (_action: string, level: number) =>
          level >= redactLevel,
      }),
    }),
    findEventById: (id: string) => events.find((e) => e.getId() === id),
    getMember: (id: string) => ({
      name: id === '@me:hs' ? 'Me' : 'Alice',
      getMxcAvatarUrl: () => null,
      powerLevel: id === '@me:hs' ? myPower : 0,
    }),
    getMembers: () => members,
    getUsersReadUpTo: (event: { getId: () => string }) =>
      receiptsByEvent[event.getId()] ?? [],
    getAccountData: (type: string) =>
      type === 'm.fully_read' && fullyReadEventId
        ? { getContent: () => ({ event_id: fullyReadEventId }) }
        : undefined,
    relations: {
      getChildEventsForEvent: (
        id: string,
        relType?: string,
        evType?: string,
      ) =>
        relType === 'm.annotation' && evType === 'm.reaction'
          ? reactions[id]
          : undefined,
    },
    hasEncryptionStateEvent: () => encrypted,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    },
    handlers,
    off: () => {},
  };
}

/** A fake matrix-js-sdk client that records everything it is asked to send. */
export function fakeClient(
  room: ReturnType<typeof fakeRoom>,
  sent: unknown[][],
) {
  // Captured event listeners keyed by event name, so a test can fire e.g. the
  // RoomMember.typing handler the service registers in open().
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let txn = 0;
  const threaded = ([first]: unknown[]) =>
    first === null || (typeof first === 'string' && first.startsWith('$'));
  return {
    baseUrl: 'https://hs',
    getRoom: () => room,
    getUserId: () => '@me:hs',
    handlers,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    },
    off: () => {},
    // The timeout is recorded, not dropped: it is the only argument that says how long the
    // server keeps us marked as typing, and while it went unrecorded no test could tell
    // TYPING_TIMEOUT_MS from any other number — or from nothing at all.
    sendTyping: (_rid: string, isTyping: boolean, timeoutMs?: number) => {
      sent.push(['typing', isTyping, timeoutMs]);
      return Promise.resolve({});
    },
    getCrypto: () => undefined,
    sendReadReceipt: () => Promise.resolve({}),
    setRoomReadMarkers: vi.fn(() => Promise.resolve({})),
    scrollback: () => Promise.resolve(room),
    sendTextMessage: (_rid: string, body: string) => {
      sent.push(['text', body]);
      return Promise.resolve({});
    },
    sendHtmlMessage: (_rid: string, body: string, html: string) => {
      sent.push(['html', body, html]);
      return Promise.resolve({});
    },
    makeTxnId: () => `txn${++txn}`,
    // Both SDK overloads: without a thread id, and the engine's with one (null or `$…`).
    sendMessage: (_rid: string, ...args: unknown[]) => {
      sent.push(['message', threaded(args) ? args[1] : args[0]]);
      return Promise.resolve({ event_id: `$sent${sent.length}` });
    },
    redactEvent: (_rid: string, eventId: string) => {
      sent.push(['redact', eventId]);
      return Promise.resolve({});
    },
    sendEvent: (_rid: string, ...args: unknown[]) => {
      const [type, content] = threaded(args) ? args.slice(1) : args;
      sent.push(['event', type, content]);
      return Promise.resolve({ event_id: `$sent${sent.length}` });
    },
  };
}

export function setup(
  events: ReturnType<typeof fakeEvent>[],
  sent: unknown[][] = [],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
  encrypted = false,
  power: { mine?: number; redact?: number; send?: number } = {},
) {
  const room = fakeRoom(events, reactions, encrypted, [], null, {}, power);
  const client = fakeClient(room, sent);

  TestBed.configureTestingModule({
    providers: [
      TimelineService,
      matrixProvider(client),
      mediaProvider(),
      {
        provide: CONVERSATION_MESSAGE_POLICY,
        useValue: {
          canRedactOthers: () => (power.mine ?? 0) >= (power.redact ?? 50),
          canSendMessages: () => (power.mine ?? 0) >= (power.send ?? 0),
          authorizeRedaction: () => ({ kind: 'allowed' }),
        },
      },
    ],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open(ROOM_KEY);
  return svc;
}

/**
 * The action surface over the same open room `setup` builds, bound to its client and room
 * the way the Conversation's factory binds it.
 */
export function setupActions(
  events: ReturnType<typeof fakeEvent>[],
  sent: unknown[][] = [],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
  encrypted = false,
) {
  const room = fakeRoom(events, reactions, encrypted);
  const client = fakeClient(room, sent);

  TestBed.configureTestingModule({
    providers: [
      TimelineService,
      TimelineActionsService,
      matrixProvider(client),
      mediaProvider(),
    ],
  });
  TestBed.inject(TimelineService).open(ROOM_KEY);
  TestBed.inject(ConversationActionContextService).bind(() => ROOM_KEY);
  return TestBed.inject(TimelineActionsService);
}

/** Opens `!r:hs` on a TimelineService over `client`, plus any per-test providers. */
export function openTimeline(client: unknown, extraProviders: Provider[] = []) {
  TestBed.configureTestingModule({
    providers: [TimelineService, matrixProvider(client), ...extraProviders],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open(ROOM_KEY);
  return svc;
}

/** The harness client over a room a test has tweaked (the harness types its own room strictly). */
export function clientFor(room: object, overrides: object = {}) {
  return {
    ...fakeClient(room as ReturnType<typeof fakeRoom>, []),
    ...overrides,
  };
}
