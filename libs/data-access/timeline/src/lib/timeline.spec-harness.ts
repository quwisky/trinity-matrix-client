// Shared TestBed scaffolding for the timeline specs.
//
// TimelineService (the open-room projection) and TimelineActionsService (the write
// surface) are two services over the SAME fake room + client, so their specs need the
// same doubles. This holds them so neither file owns a private copy that can drift.
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { TimelineService } from './timeline.service';
import { TimelineActionsService } from './timeline-actions.service';
import { ConversationActionContextService } from './conversation-action-context.service';
import { CONVERSATION_MESSAGE_POLICY } from './conversation-message-adapter.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
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
              msgtype: 'm.image' as UploadedMedia['msgtype'],
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
              msgtype: 'm.image' as UploadedMedia['msgtype'],
              body: 'pic.png',
              mxc: 'mxc://hs/up',
              file: null,
              info: { mimetype: 'image/png', size: 4 },
            },
      ),
  });
}

/** Wrap a fake matrix-js-sdk client as a MatrixClientService mock. */
export function matrixProvider(client: unknown, isInitialized = true) {
  return MockProvider(MatrixClientService, {
    isInitialized,
    instance: client,
    clientFor: (accountId: string) =>
      (client as { getUserId?: () => string | null }).getUserId?.() ===
      accountId
        ? client
        : null,
  } as Partial<MatrixClientService>);
}

/**
 * A MatrixClientService mock whose `instance` follows a mutable holder — mirroring
 * the real getter, which resolves the *active* account on every access. Lets a test
 * switch accounts and observe when the service actually reads the client.
 */
export function switchableMatrixProvider(active: {
  client: unknown;
  isInitialized?: boolean;
}) {
  return {
    provide: MatrixClientService,
    useValue: {
      get isInitialized() {
        return active.isInitialized ?? true;
      },
      get instance() {
        return active.client;
      },
    } as unknown as MatrixClientService,
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
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    replyEventId: o.replyTo,
    getRoomId: () => '!r:hs',
    getType: () => o.type ?? 'm.room.message',
    getTs: () => o.ts ?? 0,
    isState: () => o.state ?? o.stateKey !== undefined,
    getStateKey: () => o.stateKey,
    getPrevContent: () => o.prevContent ?? {},
    getContent: () =>
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
                ...(o.durationMs !== undefined
                  ? { duration: o.durationMs }
                  : {}),
                ...(o.waveform !== undefined ? { waveform: o.waveform } : {}),
              },
            }
          : {}),
      },
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
    isEncrypted: () => o.encrypted ?? false,
    isRelation: (relType?: string) =>
      o.editRelation === true &&
      (relType === undefined || relType === 'm.replace'),
    replacingEvent: () => (o.edited ? {} : null),
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

/** A room member as {@link TimelineService.refreshTyping} reads it. */
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
  power: { mine?: number; redact?: number } = {},
) {
  const myPower = power.mine ?? 0;
  const redactLevel = power.redact ?? 50;
  return {
    roomId: '!r:hs',
    // Room state hangs off the live timeline (what liveRoomState() reads, and what
    // the SDK's deprecated `currentState` aliased).
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
    on: () => {},
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
    sendMessage: (_rid: string, content: unknown) => {
      sent.push(['message', content]);
      return Promise.resolve({});
    },
    redactEvent: (_rid: string, eventId: string) => {
      sent.push(['redact', eventId]);
      return Promise.resolve({});
    },
    sendEvent: (_rid: string, type: string, content: unknown) => {
      sent.push(['event', type, content]);
      return Promise.resolve({});
    },
  };
}

export function setup(
  events: ReturnType<typeof fakeEvent>[],
  sent: unknown[][] = [],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
  encrypted = false,
  power: { mine?: number; redact?: number } = {},
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
          authorizeRedaction: () => ({ kind: 'allowed' }),
        },
      },
    ],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open('!r:hs');
  return svc;
}

/**
 * The action surface over the same open room `setup` builds. Both services are real:
 * the actions resolve the open room through {@link TimelineService.openContext}, so a
 * mocked projection would test nothing.
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
  const timeline = TestBed.inject(TimelineService);
  timeline.open('!r:hs');
  TestBed.inject(ConversationActionContextService).bind(() =>
    timeline.openContext(),
  );
  return TestBed.inject(TimelineActionsService);
}
