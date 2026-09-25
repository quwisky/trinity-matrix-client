import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DESKTOP_ACCOUNT_PROFILE,
  type AccountViewportProfile,
} from './account-workspace-client.mts';

export const MESSAGE_LINKS_SOURCE =
  'e2e/browser/journeys/conversations/message-links.spec.mts';
export const MESSAGE_LINKS_SOURCE_SHA256 =
  '513b7f01b026991d316479edf06caef9754e70cc0df157a37436a67982aeb400';
export const MESSAGE_LINKS_SOURCE_LINES = 605;

export const MESSAGE_LINKS_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/browser/support/contrast.mts':
    '5c5561a7cd599679a95735fe82cbe14b95faf93c359f3f4ef7e85aa386b2b7f3',
  'e2e/fixtures.mts':
    '7358d2f7ddcac9c9b6bec9531cef12cc1d097ac7a6199897a21dc524978b8396',
  'e2e/support/navigation.mts':
    '6ee2fc9fb014bf39d92fe88ffb7c0afafccbed3219575a480da404efe1f93c15',
} as const;

export const MESSAGE_LINKS_STAGE_IDS = [
  'joined-preview',
  'federated-join',
  'remote-unavailable',
  'rejected-join',
  'portrait-sheet',
  'mention-user-card',
] as const;

export type MessageLinksStageId = (typeof MESSAGE_LINKS_STAGE_IDS)[number];

export interface MessageLinksSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * Owned predecessor spans. The mention definition ends at the Android `return;` on
 * line 587; its web-only popover tail (588–604) is excluded.
 */
export const MESSAGE_LINKS_SPANS = {
  helpers: { from: 22, to: 147 },
  definitions: {
    'joined-preview': { from: 156, to: 230 },
    'federated-join': { from: 232, to: 321 },
    'remote-unavailable': { from: 323, to: 362 },
    'rejected-join': { from: 364, to: 424 },
    'portrait-sheet': { from: 433, to: 504 },
    'mention-user-card': { from: 507, to: 587 },
  },
  portraitUse: { from: 427, to: 431 },
  portraitSkipLine: 437,
  androidBranchLine: 578,
  androidReturnLine: 587,
  excludedTail: { from: 588, to: 604 },
} as const satisfies {
  readonly helpers: MessageLinksSpan;
  readonly definitions: Readonly<Record<MessageLinksStageId, MessageLinksSpan>>;
  readonly portraitUse: MessageLinksSpan;
  readonly portraitSkipLine: number;
  readonly androidBranchLine: number;
  readonly androidReturnLine: number;
  readonly excludedTail: MessageLinksSpan;
};

/** Web-only `expect` sites after the Android `return;`; never Android parity records. */
export const MESSAGE_LINKS_EXCLUDED_TAIL_SITES = [
  591, 595, 596, 597, 598, 600,
] as const;

/** Module-level predecessor helpers whose own `expect` line an inherited site expands. */
export const MESSAGE_LINKS_HELPER_EXPECT_LINES = {
  loginApi: 37,
  registerRemote: 58,
  createRoom: 76,
  sendRoomLink: 100,
  openRoom: 129,
} as const;

export type MessageLinksHelper = keyof typeof MESSAGE_LINKS_HELPER_EXPECT_LINES;

/** Helper-internal call lines inside `localScenario` (103–122). */
export const MESSAGE_LINKS_LOCAL_SCENARIO_VIA = {
  loginApi: 118,
  createRoom: 120,
} as const;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited site's
 * `helper` owns that line, `call` is the stage-body call line and `via` is the
 * helper-internal line reached through `localScenario`.
 */
export type MessageLinksSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageLinksHelper;
      readonly call: number;
      readonly via?: number;
    };

const joinedPreviewSites = [
  { line: 129, suffix: 'room-open', kind: 'inherited', helper: 'openRoom', call: 206 },
  { line: 214, suffix: 'preview-visible', kind: 'direct' },
  { line: 215, suffix: 'target-name', kind: 'direct' },
  { line: 217, suffix: 'open-action', kind: 'direct' },
  { line: 218, suffix: 'source-still-active', kind: 'direct' },
  { line: 225, suffix: 'target-opened', kind: 'direct' },
] as const satisfies readonly MessageLinksSite[];

const federatedJoinSites = [
  { line: 37, suffix: 'api-login', kind: 'inherited', helper: 'loginApi', call: 237, via: 118 },
  { line: 76, suffix: 'source-room-created', kind: 'inherited', helper: 'createRoom', call: 237, via: 120 },
  { line: 58, suffix: 'remote-registered', kind: 'inherited', helper: 'registerRemote', call: 239 },
  { line: 76, suffix: 'remote-room-created', kind: 'inherited', helper: 'createRoom', call: 248 },
  { line: 100, suffix: 'link-sent', kind: 'inherited', helper: 'sendRoomLink', call: 255 },
  { line: 129, suffix: 'room-open', kind: 'inherited', helper: 'openRoom', call: 270 },
  { line: 274, suffix: 'remote-name', kind: 'direct' },
  { line: 277, suffix: 'remote-topic', kind: 'direct' },
  { line: 280, suffix: 'join-action', kind: 'direct' },
  { line: 283, suffix: 'source-still-active', kind: 'direct' },
  { line: 291, suffix: 'joined-notice', kind: 'direct' },
  { line: 295, suffix: 'open-action', kind: 'direct' },
  { line: 296, suffix: 'open-focused', kind: 'direct' },
  { line: 304, suffix: 'light-contrast', kind: 'direct' },
  { line: 308, suffix: 'dark-contrast', kind: 'direct' },
  { line: 316, suffix: 'remote-opened', kind: 'direct' },
] as const satisfies readonly MessageLinksSite[];

const remoteUnavailableSites = [
  { line: 37, suffix: 'api-login', kind: 'inherited', helper: 'loginApi', call: 328, via: 118 },
  { line: 76, suffix: 'source-room-created', kind: 'inherited', helper: 'createRoom', call: 328, via: 120 },
  { line: 58, suffix: 'remote-registered', kind: 'inherited', helper: 'registerRemote', call: 329 },
  { line: 76, suffix: 'remote-room-created', kind: 'inherited', helper: 'createRoom', call: 334 },
  { line: 100, suffix: 'link-sent', kind: 'inherited', helper: 'sendRoomLink', call: 338 },
  { line: 129, suffix: 'room-open', kind: 'inherited', helper: 'openRoom', call: 353 },
  { line: 359, suffix: 'load-error-visible', kind: 'direct' },
  { line: 360, suffix: 'load-error-guidance', kind: 'direct' },
  { line: 361, suffix: 'no-primary-action', kind: 'direct' },
] as const satisfies readonly MessageLinksSite[];

const rejectedJoinSites = [
  { line: 37, suffix: 'api-login', kind: 'inherited', helper: 'loginApi', call: 369, via: 118 },
  { line: 76, suffix: 'source-room-created', kind: 'inherited', helper: 'createRoom', call: 369, via: 120 },
  { line: 58, suffix: 'remote-registered', kind: 'inherited', helper: 'registerRemote', call: 370 },
  { line: 76, suffix: 'remote-room-created', kind: 'inherited', helper: 'createRoom', call: 375 },
  { line: 100, suffix: 'link-sent', kind: 'inherited', helper: 'sendRoomLink', call: 379 },
  { line: 129, suffix: 'room-open', kind: 'inherited', helper: 'openRoom', call: 394 },
  { line: 399, suffix: 'join-action', kind: 'direct' },
  { line: 413, suffix: 'join-rule-invite', kind: 'direct' },
  { line: 418, suffix: 'action-error', kind: 'direct' },
  { line: 421, suffix: 'join-retained', kind: 'direct' },
  { line: 422, suffix: 'join-focused', kind: 'direct' },
  { line: 423, suffix: 'preview-retained', kind: 'direct' },
] as const satisfies readonly MessageLinksSite[];

const portraitSheetSites = [
  { line: 37, suffix: 'api-login', kind: 'inherited', helper: 'loginApi', call: 439, via: 118 },
  { line: 76, suffix: 'source-room-created', kind: 'inherited', helper: 'createRoom', call: 439, via: 120 },
  { line: 76, suffix: 'target-room-created', kind: 'inherited', helper: 'createRoom', call: 441 },
  { line: 100, suffix: 'link-sent', kind: 'inherited', helper: 'sendRoomLink', call: 444 },
  { line: 129, suffix: 'room-open', kind: 'inherited', helper: 'openRoom', call: 459 },
  { line: 465, suffix: 'preview-visible', kind: 'direct' },
  { line: 466, suffix: 'sheet-class', kind: 'direct' },
  { line: 469, suffix: 'open-action', kind: 'direct' },
  { line: 492, suffix: 'portrait', kind: 'direct' },
  { line: 493, suffix: 'left-edge', kind: 'direct' },
  { line: 494, suffix: 'right-edge', kind: 'direct' },
  { line: 497, suffix: 'bottom-edge', kind: 'direct' },
  { line: 500, suffix: 'footer-top', kind: 'direct' },
  { line: 501, suffix: 'footer-bottom', kind: 'direct' },
] as const satisfies readonly MessageLinksSite[];

const mentionUserCardSites = [
  { line: 129, suffix: 'room-open', kind: 'inherited', helper: 'openRoom', call: 566 },
  { line: 573, suffix: 'card-visible', kind: 'direct' },
  { line: 574, suffix: 'card-name', kind: 'direct' },
  { line: 579, suffix: 'no-anchored-popover', kind: 'direct' },
  { line: 582, suffix: 'dialog-name', kind: 'direct' },
  { line: 583, suffix: 'room-retained', kind: 'direct' },
] as const satisfies readonly MessageLinksSite[];

/** The retained predecessor's portrait `test.use` (427–431) with Playwright's implicit DPR 1. */
export const PORTRAIT_LINK_PROFILE: AccountViewportProfile = {
  width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
};

export type MessageLinksProfileName = 'desktop' | 'portrait';

export const MESSAGE_LINKS_PROFILES: Readonly<
  Record<MessageLinksProfileName, AccountViewportProfile>
> = {
  desktop: DESKTOP_ACCOUNT_PROFILE,
  portrait: PORTRAIT_LINK_PROFILE,
};

export const MESSAGE_LINKS_STAGE_PROFILES: Readonly<
  Record<MessageLinksStageId, MessageLinksProfileName>
> = {
  'joined-preview': 'desktop',
  'federated-join': 'desktop',
  'remote-unavailable': 'desktop',
  'rejected-join': 'desktop',
  'portrait-sheet': 'portrait',
  'mention-user-card': 'desktop',
};

/** Predecessor run-token suffix letter per stage. */
export const MESSAGE_LINKS_RUN_SUFFIX = {
  'joined-preview': 'l',
  'federated-join': 'f',
  'remote-unavailable': 'x',
  'rejected-join': 'r',
  'portrait-sheet': 'm',
  'mention-user-card': 'u',
} as const satisfies Readonly<Record<MessageLinksStageId, string>>;

export type MessageLinksAssertion = `message-links.${MessageLinksStageId}.${string}`;

export interface MessageLinksStage {
  readonly id: MessageLinksStageId;
  readonly source: string;
  readonly title: string;
  readonly profile: AccountViewportProfile;
  readonly sites: readonly MessageLinksSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageLinksAssertion[];
}

function stage(
  id: MessageLinksStageId,
  title: string,
  sites: readonly MessageLinksSite[],
): MessageLinksStage {
  const span = MESSAGE_LINKS_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_LINKS_SOURCE}:${span.from}-${span.to}`,
    title,
    profile: MESSAGE_LINKS_PROFILES[MESSAGE_LINKS_STAGE_PROFILES[id]],
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessageLinksAssertion => `message-links.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_LINKS_STAGES: readonly MessageLinksStage[] = [
  stage('joined-preview',
    'a joined room previews before an explicit Open', joinedPreviewSites),
  stage('federated-join',
    'previews and joins a public room across real federation', federatedJoinSites),
  stage('remote-unavailable',
    'shows a useful unavailable state for an inaccessible remote room',
    remoteUnavailableSites),
  stage('rejected-join',
    'keeps a rejected federated Join open and retryable', rejectedJoinSites),
  stage('portrait-sheet',
    'keeps the sheet and its action footer reachable', portraitSheetSites),
  stage('mention-user-card',
    'clicking a mention shows a user card, not an empty room',
    mentionUserCardSites),
];

export const MESSAGE_LINKS_STAGE_COUNTS = [6, 16, 9, 12, 14, 6] as const;
export const MESSAGE_LINKS_DIRECT_COUNTS = [5, 10, 3, 6, 9, 5] as const;
export const MESSAGE_LINKS_INHERITED_COUNTS = [1, 6, 6, 6, 5, 1] as const;
export const MESSAGE_LINKS_ASSERTION_RECORDS = 63;
export const MESSAGE_LINKS_DIRECT = 38;
export const MESSAGE_LINKS_INHERITED = 25;

export const AA_NORMAL_TEXT = 4.5;
export const SUCCESS_TEXT = 'Room joined. It is ready to open.';
export const OPEN_ROOM_LABEL = 'Open room';
export const JOIN_ROOM_LABEL = 'Join room';
export const SHEET_CLASS = 'room-link-preview--sheet';
export const PORTRAIT_TOLERANCE_PX = 1;
export const UNAVAILABLE_COPY = [
  {
    title: 'Room not found',
    message: 'This room address is unknown or no longer exists.',
  },
  {
    title: 'Room unavailable',
    message: 'This room does not allow its information to be previewed.',
  },
] as const;

function siteKey(site: MessageLinksSite): readonly [number, number] {
  return site.kind === 'direct'
    ? [site.line, 0]
    : [site.call, site.via ?? 0];
}

function within(line: number, span: MessageLinksSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_LINKS_STAGES.map(({ id }) => id),
    [...MESSAGE_LINKS_STAGE_IDS], 'Message-links stages keep source order');
  assert.deepEqual(MESSAGE_LINKS_STAGES.map((entry) => entry.sites.length),
    [...MESSAGE_LINKS_STAGE_COUNTS], 'Message-links per-stage record counts');
  assert.deepEqual(
    MESSAGE_LINKS_STAGES.map((entry) =>
      entry.sites.filter((site) => site.kind === 'direct').length),
    [...MESSAGE_LINKS_DIRECT_COUNTS], 'Message-links per-stage direct counts');
  assert.deepEqual(
    MESSAGE_LINKS_STAGES.map((entry) =>
      entry.sites.filter((site) => site.kind === 'inherited').length),
    [...MESSAGE_LINKS_INHERITED_COUNTS],
    'Message-links per-stage inherited counts');
  const sites = MESSAGE_LINKS_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_LINKS_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_LINKS_ASSERTION_RECORDS,
    'Message-links owns exactly 63 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_LINKS_DIRECT, 'Message-links owns exactly 38 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_LINKS_INHERITED, 'Message-links owns exactly 25 inherited sites');
  assert.equal(identities.length, MESSAGE_LINKS_ASSERTION_RECORDS,
    'Every site has one identity');
  assert.equal(new Set(identities).size, MESSAGE_LINKS_ASSERTION_RECORDS,
    'Message-links identities are unique');
  const localScenarioCalls = new Set<number>();
  for (const entry of MESSAGE_LINKS_STAGES) {
    const span = MESSAGE_LINKS_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    assert.equal(entry.profile,
      MESSAGE_LINKS_PROFILES[MESSAGE_LINKS_STAGE_PROFILES[entry.id]],
      `${entry.id} uses its mapped profile`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-links\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
      `${identity} is a stage-local identity`);
    }
    let previous: readonly [number, number] = [0, 0];
    for (const site of entry.sites) {
      const key = siteKey(site);
      assert(key[0] > previous[0] ||
        (key[0] === previous[0] && key[1] > previous[1]),
      `${entry.id}.${site.suffix} keeps source order`);
      previous = key;
      if (site.kind === 'direct') {
        assert(within(site.line, span),
          `${entry.id}.${site.suffix} lies inside its definition`);
        assert(!(MESSAGE_LINKS_EXCLUDED_TAIL_SITES as readonly number[])
          .includes(site.line), `${site.line} is not a web-tail site`);
        continue;
      }
      assert.equal(site.line, MESSAGE_LINKS_HELPER_EXPECT_LINES[site.helper],
        `${entry.id}.${site.suffix} expands ${site.helper}'s expect line`);
      assert(within(site.line, MESSAGE_LINKS_SPANS.helpers),
        `${entry.id}.${site.suffix} expect line lies inside the helpers`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
      if (site.via !== undefined) {
        assert(site.helper === 'loginApi' || site.helper === 'createRoom',
          `${entry.id}.${site.suffix} reaches localScenario only for login/create`);
        assert.equal(site.via, MESSAGE_LINKS_LOCAL_SCENARIO_VIA[site.helper],
          `${entry.id}.${site.suffix} via line is localScenario's call`);
        localScenarioCalls.add(site.call);
      }
    }
  }
  assert.deepEqual([...localScenarioCalls], [237, 328, 369, 439],
    'localScenario expands at exactly its four stage-body calls');
  assert.deepEqual(
    MESSAGE_LINKS_STAGES.map((entry) => MESSAGE_LINKS_STAGE_PROFILES[entry.id]),
    ['desktop', 'desktop', 'desktop', 'desktop', 'portrait', 'desktop'],
    'Five desktop stages and one portrait stage');
}

validateContract();

function entryFor(stageId: MessageLinksStageId): MessageLinksStage {
  const entry = MESSAGE_LINKS_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-links stage ${stageId}`);
  return entry;
}

export function messageLinksStage(stageId: MessageLinksStageId): MessageLinksStage {
  return entryFor(stageId);
}

export function messageLinksAssertion(
  stageId: MessageLinksStageId,
  suffix: string,
): MessageLinksAssertion {
  const entry = entryFor(stageId);
  const identity: MessageLinksAssertion = `message-links.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageLinksRecords(
  stageId: MessageLinksStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageLinksReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9-]+$/, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-links.'),
    `Receipt ${name} is not a parity identity`);
}

export interface MessageLinksProfileRecord {
  readonly requested: AccountViewportProfile;
  readonly digest: string;
}

/** Same digest formula as `runtime-provenance.mts`: sha256 of the JSON profile. */
export function messageLinksProfileDigest(profile: AccountViewportProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

/** The suite-owned `profiles.json` payload, keyed by stage id in contract order. */
export function messageLinksProfiles(): Readonly<
  Record<MessageLinksStageId, MessageLinksProfileRecord>
> {
  return Object.fromEntries(MESSAGE_LINKS_STAGES.map((entry) => [
    entry.id,
    { requested: entry.profile, digest: messageLinksProfileDigest(entry.profile) },
  ])) as Record<MessageLinksStageId, MessageLinksProfileRecord>;
}

// Predecessor text and link templates (195, 260, 343, 384, 449, 560).

export const MESSAGE_LINKS_LABELS = {
  'joined-preview': 'the target room',
  'federated-join': 'open the federated room',
  'remote-unavailable': 'open a private remote room',
  'rejected-join': 'open a room whose join will fail',
  'portrait-sheet': 'open the portrait target',
} as const;

export const messageLinksNames = {
  sourceRoom: (run: string): string => `Link Source ${run}`,
  targetRoom: (run: string): string => `Link Target ${run}`,
  federatedRoom: (run: string): string => `Federated Room ${run}`,
  federatedTopic: (serverName: string): string => `Served by ${serverName}`,
  federatedRemote: (run: string): string => `remote-${run}`,
  federatedAliasLocalpart: (run: string): string => `federated-${run}`,
  alias: (localpart: string, serverName: string): string =>
    `#${localpart}:${serverName}`,
  privateRemote: (run: string): string => `private-${run}`,
  privateRoom: (run: string): string => `Private ${run}`,
  retryRemote: (run: string): string => `retry-${run}`,
  retryRoom: (run: string): string => `Join Retry ${run}`,
  portraitTarget: (run: string): string => `Portrait Target ${run}`,
  mentionRoom: (run: string): string => `Mention Room ${run}`,
  bobName: (run: string): string => `Bobby${run}`,
  linkTxn: (run: string): string => `link-${run}`,
  mentionTxn: (run: string): string => `mention-${run}`,
} as const;

export const messageLinksHrefs = {
  /** Line 195. */
  joinedTarget: (targetId: string): string => `https://matrix.to/#/${targetId}`,
  /** Line 260. */
  federatedAlias: (alias: string): string =>
    `https://matrix.to/#/${encodeURIComponent(alias)}`,
  /** Line 343. */
  privateRemote: (roomId: string, serverName: string): string =>
    `https://matrix.to/#/${roomId}?via=${encodeURIComponent(serverName)}`,
  /** Line 384. */
  rejectedJoin: (roomId: string, serverName: string): string =>
    `matrix:roomid/${roomId.slice(1)}?via=${encodeURIComponent(serverName)}`,
  /**
   * The line-384 link as the renderer presents it: `normaliseMatrixUris` rewrites
   * every `matrix:` href through `matrixToPermalink`, which encodes the Room id.
   */
  rejectedJoinRendered: (roomId: string, serverName: string): string =>
    `https://matrix.to/#/${encodeURIComponent(roomId)}?via=${encodeURIComponent(serverName)}`,
  /** Line 449. */
  portraitTarget: (targetId: string): string => `https://matrix.to/#/${targetId}`,
  /** Line 560. */
  mentionUser: (userId: string): string => `https://matrix.to/#/${userId}`,
} as const;

export interface FormattedMessage {
  readonly body: string;
  readonly formattedBody: string;
}

/** `sendRoomLink` content (93–96). */
export function roomLinkMessage(href: string, label: string): FormattedMessage {
  return { body: label, formattedBody: `<a href="${href}">${label}</a>` };
}

/** Joined-preview content (193–195). */
export function joinedPreviewMessage(
  targetName: string,
  targetId: string,
): FormattedMessage {
  return {
    body: `open ${targetName}`,
    formattedBody:
      `open <a href="${messageLinksHrefs.joinedTarget(targetId)}">the target room</a>`,
  };
}

/** Mention content (558–560). */
export function mentionMessage(bobName: string, bobId: string): FormattedMessage {
  return {
    body: `hey ${bobName}`,
    formattedBody:
      `hey <a href="${messageLinksHrefs.mentionUser(bobId)}">${bobName}</a>`,
  };
}

// Shared field readers.

function object(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${name} is an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const candidate = value[name];
  assert(typeof candidate === 'string', `${name} is a string`);
  return candidate;
}

function nullableStringField(
  value: Record<string, unknown>,
  name: string,
): string | null {
  const candidate = value[name];
  assert(candidate === null || typeof candidate === 'string',
    `${name} is a string or null`);
  return candidate;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const candidate = value[name];
  assert(typeof candidate === 'boolean', `${name} is a boolean`);
  return candidate;
}

function numberField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number' && Number.isFinite(candidate),
    `${name} is finite`);
  return candidate;
}

function countField(value: Record<string, unknown>, name: string): number {
  const candidate = numberField(value, name);
  assert(Number.isInteger(candidate) && candidate >= 0,
    `${name} is a nonnegative integer`);
  return candidate;
}

function stringArrayField(
  value: Record<string, unknown>,
  name: string,
): readonly string[] {
  const candidate = value[name];
  assert(Array.isArray(candidate) &&
    candidate.every((item: unknown) => typeof item === 'string'),
  `${name} is a string array`);
  return candidate as string[];
}

// Route, placeholder and source surface.

export function roomRouteSegment(roomId: string): string {
  return Buffer.from(roomId).toString('base64url');
}

export function assertRoomRoute(url: string, roomId: string, userId: string): void {
  const route = new URL(url);
  assert.equal(route.pathname, `/rooms/${roomRouteSegment(roomId)}`,
    'Native navigation reached the exact Room');
  assert.equal(route.searchParams.get('account'), userId,
    'Native navigation retained the exact Account');
  assert.equal(route.searchParams.get('view'), 'rooms',
    'Native navigation retained the Rooms view');
}

/** `[data-testid="composer-input"]` placeholder attribute plus the document href. */
export interface ComposerPlaceholderObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly placeholder: string | null;
  readonly href: string;
}

export function parseComposerPlaceholder(value: unknown): ComposerPlaceholderObservation {
  const observation = object(value, 'Composer placeholder');
  return {
    count: countField(observation, 'count'),
    visible: booleanField(observation, 'visible'),
    placeholder: nullableStringField(observation, 'placeholder'),
    href: stringField(observation, 'href'),
  };
}

export function assertExactPlaceholder(
  observation: ComposerPlaceholderObservation,
  roomName: string,
): void {
  assert.equal(observation.count, 1, 'Exactly one composer is rendered');
  assert(observation.visible, 'The composer is visible');
  assert.equal(observation.placeholder, `Message #${roomName}`,
    'The composer names the exact active Room');
}

export interface RoomIdentity {
  readonly name: string;
  readonly roomId: string;
  readonly userId: string;
}

/** The composer placeholder and route both name `room`. */
export function assertActiveRoom(
  observation: ComposerPlaceholderObservation,
  room: RoomIdentity,
): void {
  assertExactPlaceholder(observation, room.name);
  assertRoomRoute(observation.href, room.roomId, room.userId);
}

/**
 * The preview is information, not navigation: the source Room is still active
 * and unchanged from the observation taken before the link tap.
 */
export function assertSourceStillActive(
  before: ComposerPlaceholderObservation,
  after: ComposerPlaceholderObservation,
  source: RoomIdentity,
): void {
  assertActiveRoom(before, source);
  assertActiveRoom(after, source);
  assert.equal(after.href, before.href, 'The preview did not change the route');
}

// Room-link preview.

export interface RoomLinkNoticeObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly text: string | null;
}

/**
 * Read-only preview state. Text values are whitespace-collapsed trimmed
 * `textContent`, or null when the element is absent or ambiguous.
 */
export interface RoomLinkPreviewObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly hostCount: number;
  /** `trn-room-link-preview` host class list. */
  readonly hostClasses: readonly string[];
  readonly name: string | null;
  readonly topic: string | null;
  readonly address: string | null;
  readonly primary: {
    readonly count: number;
    readonly documentCount: number;
    readonly visible: boolean;
    readonly text: string | null;
    readonly ariaDisabled: string | null;
    readonly disabled: boolean;
    readonly focused: boolean;
  };
  readonly success: RoomLinkNoticeObservation;
  readonly actionError: RoomLinkNoticeObservation;
  readonly loadError: {
    readonly count: number;
    readonly visible: boolean;
    readonly title: string | null;
    readonly message: string | null;
    readonly retryCount: number;
  };
  readonly unavailable: string | null;
  /** Retry buttons anywhere in the preview section. */
  readonly retryCount: number;
}

function parseNotice(value: unknown, name: string): RoomLinkNoticeObservation {
  const notice = object(value, name);
  return {
    count: countField(notice, 'count'),
    visible: booleanField(notice, 'visible'),
    text: nullableStringField(notice, 'text'),
  };
}

export function parseRoomLinkPreview(value: unknown): RoomLinkPreviewObservation {
  const preview = object(value, 'Room-link preview');
  const primary = object(preview['primary'], 'Room-link primary');
  const loadError = object(preview['loadError'], 'Room-link load error');
  return {
    count: countField(preview, 'count'),
    visible: booleanField(preview, 'visible'),
    hostCount: countField(preview, 'hostCount'),
    hostClasses: stringArrayField(preview, 'hostClasses'),
    name: nullableStringField(preview, 'name'),
    topic: nullableStringField(preview, 'topic'),
    address: nullableStringField(preview, 'address'),
    primary: {
      count: countField(primary, 'count'),
      documentCount: countField(primary, 'documentCount'),
      visible: booleanField(primary, 'visible'),
      text: nullableStringField(primary, 'text'),
      ariaDisabled: nullableStringField(primary, 'ariaDisabled'),
      disabled: booleanField(primary, 'disabled'),
      focused: booleanField(primary, 'focused'),
    },
    success: parseNotice(preview['success'], 'Room-link success'),
    actionError: parseNotice(preview['actionError'], 'Room-link action error'),
    loadError: {
      count: countField(loadError, 'count'),
      visible: booleanField(loadError, 'visible'),
      title: nullableStringField(loadError, 'title'),
      message: nullableStringField(loadError, 'message'),
      retryCount: countField(loadError, 'retryCount'),
    },
    unavailable: nullableStringField(preview, 'unavailable'),
    retryCount: countField(preview, 'retryCount'),
  };
}

export type RoomLinkPrimaryLabel = typeof OPEN_ROOM_LABEL | typeof JOIN_ROOM_LABEL;

export interface RoomLinkPreviewExpectation {
  readonly name: string;
  /** Null expects no topic; undefined leaves it unchecked. */
  readonly topic?: string | null;
  readonly address?: string;
  readonly primary: RoomLinkPrimaryLabel;
  readonly focused?: boolean;
}

export function assertPreviewVisible(preview: RoomLinkPreviewObservation): void {
  assert.equal(preview.count, 1, 'Exactly one room-link preview is open');
  assert(preview.visible, 'The room-link preview is visible');
}

export function assertPreviewClosed(preview: RoomLinkPreviewObservation): void {
  assert.equal(preview.count, 0, 'The room-link preview is closed');
}

export function assertPreviewName(
  preview: RoomLinkPreviewObservation,
  name: string,
): void {
  assertPreviewVisible(preview);
  assert.equal(preview.name, name, 'The preview names the exact Room');
}

export function assertPreviewTopic(
  preview: RoomLinkPreviewObservation,
  topic: string,
): void {
  assertPreviewVisible(preview);
  assert.equal(preview.topic, topic, 'The preview shows the exact topic');
}

/** One visible, enabled, settled primary with the exact label, optionally focused. */
export function assertPrimaryAction(
  preview: RoomLinkPreviewObservation,
  label: RoomLinkPrimaryLabel,
  focused?: boolean,
): void {
  assertPreviewVisible(preview);
  assert.equal(preview.primary.count, 1, 'Exactly one primary action');
  assert(preview.primary.visible, 'The primary action is visible');
  assert.equal(preview.primary.text, label, `The primary action reads ${label}`);
  assert.notEqual(preview.primary.ariaDisabled, 'true',
    'The primary action is not busy');
  assert.equal(preview.primary.disabled, false, 'The primary action is enabled');
  if (focused !== undefined) {
    assert.equal(preview.primary.focused, focused,
      focused ? 'The primary action keeps focus' : 'The primary action is unfocused');
  }
}

export function assertRoomLinkPreview(
  preview: RoomLinkPreviewObservation,
  expected: RoomLinkPreviewExpectation,
): void {
  assertPreviewName(preview, expected.name);
  if (expected.topic !== undefined) {
    assert.equal(preview.topic, expected.topic, 'The preview shows the exact topic');
  }
  if (expected.address !== undefined) {
    assert.equal(preview.address, expected.address,
      'The preview shows the exact address');
  }
  assertPrimaryAction(preview, expected.primary, expected.focused);
}

export function assertSheetClass(preview: RoomLinkPreviewObservation): void {
  assertPreviewVisible(preview);
  assert.equal(preview.hostCount, 1, 'Exactly one preview host');
  assert(preview.hostClasses.includes(SHEET_CLASS),
    'The preview host uses the phone sheet class');
}

/** 291 accepts the predecessor's `Room joined` substring; `exact` pins the full copy. */
export function assertJoinSuccess(
  preview: RoomLinkPreviewObservation,
  exact = false,
): void {
  assertPreviewVisible(preview);
  assert.equal(preview.success.count, 1, 'Exactly one success notice');
  assert(preview.success.visible, 'The success notice is visible');
  assert(preview.success.text?.includes('Room joined'),
    'The success notice reports the joined Room');
  if (exact) {
    assert.equal(preview.success.text, SUCCESS_TEXT, 'The success notice is exact');
  }
}

export function assertActionError(preview: RoomLinkPreviewObservation): void {
  assertPreviewVisible(preview);
  assert.equal(preview.actionError.count, 1, 'Exactly one action error');
  assert(preview.actionError.visible, 'The action error is visible');
  assert(preview.actionError.text, 'The action error has text');
}

export function assertLoadErrorVisible(preview: RoomLinkPreviewObservation): void {
  assert.equal(preview.loadError.count, 1, 'Exactly one load error');
  assert(preview.loadError.visible, 'The load error is visible');
}

/** 360 plus the exact service copy pair and no Retry (`room-link.service.ts`). */
export function assertUnavailableGuidance(preview: RoomLinkPreviewObservation): void {
  assertLoadErrorVisible(preview);
  const { title, message } = preview.loadError;
  assert.match(`${title ?? ''} ${message ?? ''}`, /Room (not found|unavailable)/,
    'The load error names the unavailable Room');
  assert(UNAVAILABLE_COPY.some((copy) =>
    copy.title === title && copy.message === message),
  'The load error is one exact unavailable title/message pair');
  assert.equal(preview.loadError.retryCount, 0, 'Unavailable guidance offers no Retry');
  assert.equal(preview.retryCount, 0, 'The preview offers no Retry');
}

export function assertNoPrimaryAction(preview: RoomLinkPreviewObservation): void {
  // Scoped to the one still-open unavailable preview: a closed or duplicated
  // preview must not read as "no primary action".
  assert.equal(preview.count, 1, 'Exactly one room-link preview is open');
  assert(preview.visible, 'The room-link preview is visible');
  assert(preview.loadError.visible, 'The unavailable load error is still shown');
  assert.equal(preview.primary.count, 0, 'No primary action is offered');
  assert.equal(preview.primary.documentCount, 0, 'No primary action exists anywhere');
}

// Link hrefs and rendered anchors.

export interface LinkTarget {
  readonly kind: 'room' | 'user';
  readonly target: string;
  readonly via: readonly string[];
}

function sigilKind(target: string): LinkTarget['kind'] {
  if (target.startsWith('!') || target.startsWith('#')) return 'room';
  if (target.startsWith('@')) return 'user';
  assert.fail(`Link target has no Matrix sigil: ${target.slice(0, 1)}`);
}

function viaParams(query: string): readonly string[] {
  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    assert(key === 'via' || key === 'action', `Unexpected link parameter ${key}`);
  }
  return params.getAll('via');
}

/** Parse a matrix.to or `matrix:` permalink to one Room or user; fail closed otherwise. */
export function parseLinkHref(href: string): LinkTarget {
  if (href.startsWith('matrix:')) {
    const [path = '', query = '', ...rest] = href.slice('matrix:'.length).split('?');
    assert.equal(rest.length, 0, 'matrix: URI has one query');
    assert(!path.includes('#') && !query.includes('#'), 'matrix: URI has no fragment');
    const segments = path.split('/');
    assert.equal(segments.length, 2, 'matrix: URI names exactly one entity');
    const [type = '', encoded = ''] = segments;
    const sigils: Readonly<Record<string, string>> = { roomid: '!', r: '#', u: '@' };
    const sigil = sigils[type];
    assert(sigil, `Unsupported matrix: URI type ${type}`);
    const id = decodeURIComponent(encoded);
    assert(id.length > 0 && !/^[!#@$]/.test(id),
      'matrix: URI identifier omits its sigil');
    const target = `${sigil}${id}`;
    return { kind: sigilKind(target), target, via: viaParams(query) };
  }
  const url = new URL(href);
  assert.equal(url.protocol, 'https:', 'Permalink uses https');
  assert.equal(url.host, 'matrix.to', 'Permalink host is matrix.to');
  assert.equal(url.pathname, '/', 'Permalink carries its entity in the fragment');
  assert.equal(url.search, '', 'Permalink has no outer query');
  assert(url.hash.startsWith('#/'), 'Permalink fragment starts with #/');
  const [path = '', query = '', ...rest] = url.hash.slice(2).split('?');
  assert.equal(rest.length, 0, 'Permalink has one query');
  assert(!path.includes('/'), 'Permalink names exactly one entity');
  const target = decodeURIComponent(path);
  return { kind: sigilKind(target), target, via: viaParams(query) };
}

export function assertLinkTarget(href: string, expected: LinkTarget): void {
  assert.deepEqual(parseLinkHref(href), {
    kind: expected.kind,
    target: expected.target,
    via: [...expected.via],
  }, 'The link resolves to the exact Matrix target');
}

export interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

export interface LinkAnchorObservation {
  readonly text: string;
  readonly href: string | null;
  readonly className: string;
  readonly rect: CssRect;
  readonly visible: boolean;
  readonly unobstructedCenter: boolean;
}

/** `.scroll a` anchors whose trimmed text equals `label`. */
export interface LinkAnchorsObservation {
  readonly label: string;
  readonly anchors: readonly LinkAnchorObservation[];
}

function rectField(value: Record<string, unknown>, name: string): CssRect {
  const rect = object(value[name], name);
  return {
    x: numberField(rect, 'x'),
    y: numberField(rect, 'y'),
    width: numberField(rect, 'width'),
    height: numberField(rect, 'height'),
    right: numberField(rect, 'right'),
    bottom: numberField(rect, 'bottom'),
  };
}

export function parseLinkAnchors(value: unknown): LinkAnchorsObservation {
  const observation = object(value, 'Link anchors');
  const anchors = observation['anchors'];
  assert(Array.isArray(anchors), 'Link anchors are an array');
  return {
    label: stringField(observation, 'label'),
    anchors: anchors.map((raw: unknown, index: number): LinkAnchorObservation => {
      const anchor = object(raw, `Link anchor ${index}`);
      return {
        text: stringField(anchor, 'text'),
        href: nullableStringField(anchor, 'href'),
        className: stringField(anchor, 'className'),
        rect: rectField(anchor, 'rect'),
        visible: booleanField(anchor, 'visible'),
        unobstructedCenter: booleanField(anchor, 'unobstructedCenter'),
      };
    }),
  };
}

/**
 * Exactly one visible, unobstructed `.scroll a` whose trimmed text is `label`
 * resolves to the expected target. `href`, when given, must also match verbatim.
 */
export function assertSingleLinkAnchor(
  observation: LinkAnchorsObservation,
  label: string,
  expected: LinkTarget & { readonly href?: string },
): LinkAnchorObservation {
  assert.equal(observation.label, label, 'Anchors were read for the exact label');
  const matches = observation.anchors.filter((anchor) => anchor.text.trim() === label);
  assert.equal(matches.length, observation.anchors.length,
    'Every observed anchor carries the exact label');
  assert.equal(matches.length, 1, `Exactly one message link reads ${label}`);
  const [anchor] = matches;
  assert(anchor!.visible, 'The message link is visible');
  assert(anchor!.rect.width > 0 && anchor!.rect.height > 0,
    'The message link has a tappable box');
  assert(anchor!.unobstructedCenter, 'The message link centre is unobstructed');
  assert(anchor!.href !== null, 'The message link has a destination');
  assertLinkTarget(anchor!.href, expected);
  if (expected.href !== undefined) {
    assert.equal(anchor!.href, expected.href, 'The message link href is exact');
  }
  return anchor!;
}

// Events and REST receipts.

export interface MessageEventObservation {
  readonly body: string;
  readonly format: string;
  readonly formattedBody: string;
}

export function assertEventId(eventId: string): void {
  assert(typeof eventId === 'string' && eventId.startsWith('$') && eventId.length > 1,
    'Sent event has a real Matrix event id');
}

export function assertSentEvent(
  event: MessageEventObservation,
  expected: FormattedMessage,
): void {
  assert.equal(event.body, expected.body, 'Event body is exact');
  assert.equal(event.format, 'org.matrix.custom.html', 'Event carries HTML');
  assert.equal(event.formattedBody, expected.formattedBody,
    'Event formatted body is the exact predecessor template');
}

export function assertApiLogin(
  login: { readonly userId: string },
  expectedUserId: string,
): void {
  assert.equal(login.userId, expectedUserId, 'API login returned the exact user');
}

export function assertRemoteUserId(
  userId: string,
  localpart: string,
  serverName: string,
): void {
  assert(serverName.length > 0, 'Secondary server name is known');
  assert.equal(userId, `@${localpart}:${serverName}`,
    'Remote registration returned the exact secondary user');
}

export interface RemoteRoomObservation {
  readonly id: string;
  readonly alias?: string;
  readonly joinRule: string;
  readonly name: string;
  readonly topic?: string;
  readonly published: boolean;
}

export function assertRemoteRoom(
  room: RemoteRoomObservation,
  expected: {
    readonly name: string;
    readonly topic?: string;
    readonly joinRule: 'public' | 'invite';
    readonly alias?: string;
    readonly published: boolean;
  },
): void {
  assert(room.id.startsWith('!') && room.id.length > 1, 'Remote Room has a Room id');
  assert.equal(room.name, expected.name, 'Remote Room name read back exactly');
  assert.equal(room.topic, expected.topic, 'Remote Room topic read back exactly');
  assert.equal(room.joinRule, expected.joinRule, 'Remote join rule read back exactly');
  assert.equal(room.alias, expected.alias, 'Remote alias resolves to the Room');
  assert.equal(room.published, expected.published,
    'Remote directory visibility read back exactly');
}

export function assertJoinRuleInvite(
  result: { readonly status: number; readonly readBack: string },
): void {
  assert(result.status >= 200 && result.status < 300, 'Join-rule change succeeded');
  assert.equal(result.readBack, 'invite', 'Authoritative join rule is invite');
}

export function assertDisplayName(actual: string | undefined, expected: string): void {
  assert.equal(actual, expected, 'Primary profile reports the exact display name');
}

// Membership on both servers.

export type MessageLinksMembershipState =
  'join' | 'leave' | 'invite' | 'ban' | 'knock' | 'absent';

export interface MembershipObservation {
  /** The local user's membership read on the secondary server as the owner. */
  readonly secondary: MessageLinksMembershipState;
  /** The local user's joined Room ids on the primary server. */
  readonly primaryJoined: readonly string[];
}

export function assertJoinedMembership(
  membership: MembershipObservation,
  roomId: string,
): void {
  assert.equal(membership.secondary, 'join',
    'The secondary server records the join');
  assert(membership.primaryJoined.includes(roomId),
    'The primary server lists the joined Room');
}

export function assertNotJoined(
  membership: MembershipObservation,
  roomId: string,
): void {
  assert.notEqual(membership.secondary, 'join',
    'The secondary server records no join');
  assert(!membership.primaryJoined.includes(roomId),
    'The primary server does not list the Room');
}

/** Leave sync before the Dark rejoin: `leave` on both servers and no sidebar row. */
export function assertLeftMembership(
  membership: MembershipObservation,
  roomId: string,
  sidebarRows: number,
): void {
  assert.equal(membership.secondary, 'leave', 'The secondary server records the leave');
  assert(!membership.primaryJoined.includes(roomId),
    'The primary server no longer lists the Room');
  assert.equal(sidebarRows, 0, 'The sidebar no longer lists the Room');
}

export interface RejectedJoinObservation {
  readonly preview: RoomLinkPreviewObservation;
  readonly name: string;
  readonly roomId: string;
  readonly membership: MembershipObservation;
  readonly joinRule: string;
  readonly tracked: boolean;
}

/** The rejected Join leaves the same preview open, retryable and focused. */
export function assertRejectedJoinState(observation: RejectedJoinObservation): void {
  assertActionError(observation.preview);
  assertPreviewName(observation.preview, observation.name);
  assertPrimaryAction(observation.preview, JOIN_ROOM_LABEL, true);
  assertNotJoined(observation.membership, observation.roomId);
  assert.equal(observation.joinRule, 'invite', 'The join rule is still invite');
  assert.equal(observation.tracked, false, 'The race Room is never tracked');
}

// Appearance mode and success contrast.

export type MessageLinksMode = 'light' | 'dark';
export type AppearanceModeId = 'system' | MessageLinksMode;

export interface AppearanceModeControl {
  readonly mode: AppearanceModeId;
  readonly count: number;
  readonly checked: boolean;
  readonly disabled: boolean;
}

/** Root appearance carriers (`appearance-document.adapter.ts`) and the checked radio. */
export interface AppliedModeObservation {
  readonly htmlDark: boolean;
  readonly theme: string | null;
  readonly density: string | null;
  readonly codeLines: string | null;
  readonly inlineFontSize: string;
  readonly codeScale: string;
  readonly modes: readonly AppearanceModeControl[];
  readonly checkedMode: AppearanceModeId | null;
  readonly checkedCount: number;
  readonly pathname: string;
  readonly href: string;
}

function modeValue(value: unknown, name: string): AppearanceModeId | null {
  assert(value === null || value === 'system' || value === 'light' || value === 'dark',
    `${name} is an Appearance mode or null`);
  return value;
}

export function parseAppliedMode(value: unknown): AppliedModeObservation {
  const mode = object(value, 'Applied mode');
  const modes = mode['modes'];
  assert(Array.isArray(modes), 'Appearance mode controls are an array');
  return {
    htmlDark: booleanField(mode, 'htmlDark'),
    theme: nullableStringField(mode, 'theme'),
    density: nullableStringField(mode, 'density'),
    codeLines: nullableStringField(mode, 'codeLines'),
    inlineFontSize: stringField(mode, 'inlineFontSize'),
    codeScale: stringField(mode, 'codeScale'),
    modes: modes.map((raw: unknown, index: number): AppearanceModeControl => {
      const control = object(raw, `Appearance mode control ${index}`);
      const id = modeValue(control['mode'], `Appearance mode control ${index} id`);
      assert(id !== null, `Appearance mode control ${index} has an id`);
      return {
        mode: id,
        count: countField(control, 'count'),
        checked: booleanField(control, 'checked'),
        disabled: booleanField(control, 'disabled'),
      };
    }),
    checkedMode: modeValue(mode['checkedMode'], 'Checked Appearance mode'),
    checkedCount: countField(mode, 'checkedCount'),
    pathname: stringField(mode, 'pathname'),
    href: stringField(mode, 'href'),
  };
}

/** The root applies `mode`; the radio check applies only while Settings is rendered. */
export function assertAppliedMode(
  observation: Pick<AppliedModeObservation, 'htmlDark'> &
    Partial<Pick<AppliedModeObservation, 'checkedMode' | 'checkedCount'>>,
  mode: MessageLinksMode,
  requireChecked = true,
): void {
  if (requireChecked) {
    assert.equal(observation.checkedCount, 1, 'Exactly one Appearance mode is checked');
    assert.equal(observation.checkedMode, mode, `The ${mode} mode radio is checked`);
  }
  assert.equal(observation.htmlDark, mode === 'dark', `The document applies ${mode}`);
}

function carriers(observation: AppliedModeObservation): Readonly<Record<string, unknown>> {
  return {
    theme: observation.theme,
    density: observation.density,
    codeLines: observation.codeLines,
    inlineFontSize: observation.inlineFontSize,
    codeScale: observation.codeScale,
  };
}

/** Only the mode changed: theme, density, text scale and code carriers are unchanged. */
export function assertModeOnlyChange(
  baseline: AppliedModeObservation,
  after: AppliedModeObservation,
  mode: MessageLinksMode,
): void {
  assertAppliedMode(after, mode);
  assert.deepEqual(carriers(after), carriers(baseline),
    'Appearance selection changed the mode only');
}

/** An opaque sRGB colour, 0-255 per channel. */
export interface Srgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** sRGB relative luminance, per WCAG 2.1 (as `e2e/browser/support/contrast.mts`). */
export function luminance({ r, g, b }: Srgb): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Srgb, b: Srgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

export interface SuccessContrastObservation {
  readonly text: string;
  readonly foreground: Srgb;
  readonly background: Srgb;
  readonly layers: readonly string[];
  readonly htmlDark: boolean;
  /** The checked Appearance radio; null when Settings is not rendered. */
  readonly checkedMode: AppearanceModeId | null;
}

function srgbField(value: Record<string, unknown>, name: string): Srgb {
  const colour = object(value[name], name);
  const channel = (key: string): number => {
    const candidate = countField(colour, key);
    assert(candidate <= 255, `${name}.${key} is an sRGB channel`);
    return candidate;
  };
  return { r: channel('r'), g: channel('g'), b: channel('b') };
}

export function parseSuccessContrast(value: unknown): SuccessContrastObservation {
  const contrast = object(value, 'Success contrast');
  const layers = stringArrayField(contrast, 'layers');
  assert(layers.length > 0, 'Contrast composited at least one layer');
  return {
    text: stringField(contrast, 'text'),
    foreground: srgbField(contrast, 'foreground'),
    background: srgbField(contrast, 'background'),
    layers,
    htmlDark: booleanField(contrast, 'htmlDark'),
    checkedMode: modeValue(contrast['checkedMode'], 'Checked Appearance mode'),
  };
}

/**
 * The success notice meets WCAG AA normal text under the real selected mode.
 * `selectedMode` is the checked radio recorded by the Appearance round trip,
 * because the preview's Room route does not render Settings.
 */
export function assertAaSuccessContrast(
  observation: SuccessContrastObservation,
  mode: MessageLinksMode,
  selectedMode: AppearanceModeId | null = observation.checkedMode,
): number {
  assert.equal(observation.text, SUCCESS_TEXT, 'Contrast measures the success notice');
  assert.equal(observation.htmlDark, mode === 'dark',
    `Contrast is measured under applied ${mode}`);
  assert.equal(selectedMode, mode,
    `Contrast is measured with the ${mode} radio selected`);
  const ratio = contrastRatio(observation.foreground, observation.background);
  assert(ratio >= AA_NORMAL_TEXT,
    `Success notice ${mode} contrast ${ratio.toFixed(2)} meets AA ${AA_NORMAL_TEXT}`);
  return ratio;
}

// Portrait sheet geometry, viewport fit and physical reach.

export type HitResult = 'self' | 'descendant' | 'other' | 'none';

/** Replica of the predecessor geometry (472–491) plus applied metrics and reach inputs. */
export interface PortraitSheetGeometry {
  readonly previewCount: number;
  readonly portrait: boolean;
  readonly surface: { readonly left: number; readonly right: number; readonly bottom: number };
  readonly footer: { readonly top: number; readonly bottom: number };
  readonly viewportBottom: number;
  readonly viewportWidth: number;
  readonly applied: {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly devicePixelRatio: number;
    readonly visualViewport: { readonly offsetTop: number; readonly height: number } | null;
  };
  readonly rects: {
    readonly section: CssRect;
    readonly footer: CssRect;
    readonly primary: CssRect | null;
    readonly close: CssRect | null;
  };
  readonly primaryCount: number;
  readonly closeCount: number;
  readonly primaryHit: HitResult;
  readonly closeHit: HitResult;
  readonly footerPaddingBottom: string;
}

function hitField(value: Record<string, unknown>, name: string): HitResult {
  const candidate = value[name];
  assert(candidate === 'self' || candidate === 'descendant' ||
    candidate === 'other' || candidate === 'none', `${name} is a hit result`);
  return candidate;
}

function visualViewportField(
  value: Record<string, unknown>,
  name: string,
): { readonly offsetTop: number; readonly height: number } | null {
  if (value[name] === null) return null;
  const viewport = object(value[name], name);
  return {
    offsetTop: numberField(viewport, 'offsetTop'),
    height: numberField(viewport, 'height'),
  };
}

export function parsePortraitGeometry(value: unknown): PortraitSheetGeometry {
  const geometry = object(value, 'Portrait geometry');
  const surface = object(geometry['surface'], 'Portrait surface');
  const footer = object(geometry['footer'], 'Portrait footer');
  const applied = object(geometry['applied'], 'Portrait applied metrics');
  const rects = object(geometry['rects'], 'Portrait rects');
  return {
    previewCount: countField(geometry, 'previewCount'),
    portrait: booleanField(geometry, 'portrait'),
    surface: {
      left: numberField(surface, 'left'),
      right: numberField(surface, 'right'),
      bottom: numberField(surface, 'bottom'),
    },
    footer: {
      top: numberField(footer, 'top'),
      bottom: numberField(footer, 'bottom'),
    },
    viewportBottom: numberField(geometry, 'viewportBottom'),
    viewportWidth: numberField(geometry, 'viewportWidth'),
    applied: {
      innerWidth: numberField(applied, 'innerWidth'),
      innerHeight: numberField(applied, 'innerHeight'),
      devicePixelRatio: numberField(applied, 'devicePixelRatio'),
      visualViewport: visualViewportField(applied, 'visualViewport'),
    },
    rects: {
      section: rectField(rects, 'section'),
      footer: rectField(rects, 'footer'),
      primary: rects['primary'] === null ? null : rectField(rects, 'primary'),
      close: rects['close'] === null ? null : rectField(rects, 'close'),
    },
    primaryCount: countField(geometry, 'primaryCount'),
    closeCount: countField(geometry, 'closeCount'),
    primaryHit: hitField(geometry, 'primaryHit'),
    closeHit: hitField(geometry, 'closeHit'),
    footerPaddingBottom: stringField(geometry, 'footerPaddingBottom'),
  };
}

type PortraitGeometryInput = Pick<PortraitSheetGeometry,
  'portrait' | 'surface' | 'footer' | 'viewportBottom' | 'viewportWidth'>;

/** The six predecessor checks (492–501) in source order, keyed by identity suffix. */
export const PORTRAIT_GEOMETRY_CHECKS = {
  portrait: (geometry: PortraitGeometryInput): void => {
    assert.equal(geometry.portrait, true, 'The viewport is portrait');
  },
  'left-edge': (geometry: PortraitGeometryInput): void => {
    assert(Math.abs(geometry.surface.left) <= PORTRAIT_TOLERANCE_PX,
      'The sheet reaches the left viewport edge');
  },
  'right-edge': (geometry: PortraitGeometryInput): void => {
    assert(Math.abs(geometry.surface.right - geometry.viewportWidth) <=
      PORTRAIT_TOLERANCE_PX, 'The sheet reaches the right viewport edge');
  },
  'bottom-edge': (geometry: PortraitGeometryInput): void => {
    assert(Math.abs(geometry.surface.bottom - geometry.viewportBottom) <=
      PORTRAIT_TOLERANCE_PX, 'The sheet reaches the visual viewport bottom');
  },
  'footer-top': (geometry: PortraitGeometryInput): void => {
    assert(geometry.footer.top >= 0, 'The footer top is on screen');
  },
  'footer-bottom': (geometry: PortraitGeometryInput): void => {
    assert(geometry.footer.bottom <= geometry.viewportBottom + PORTRAIT_TOLERANCE_PX,
      'The footer bottom is inside the visual viewport');
  },
} as const;

export type PortraitGeometryCheck = keyof typeof PORTRAIT_GEOMETRY_CHECKS;

export function assertPortraitSheetGeometry(geometry: PortraitGeometryInput): void {
  for (const check of Object.values(PORTRAIT_GEOMETRY_CHECKS)) check(geometry);
}

export interface NativePoint {
  readonly x: number;
  readonly y: number;
}

/** `client.nativeRect` result: physical corners of a CSS rect inset 0.5 px. */
export interface NativeRect {
  readonly topLeft: NativePoint;
  readonly bottomRight: NativePoint;
}

function assertNativeRect(rect: NativeRect, name: string): void {
  for (const value of [rect.topLeft.x, rect.topLeft.y, rect.bottomRight.x,
    rect.bottomRight.y]) {
    assert(Number.isFinite(value) && value >= 0, `${name} corners are on screen`);
  }
  assert(rect.topLeft.x < rect.bottomRight.x && rect.topLeft.y < rect.bottomRight.y,
    `${name} has a positive physical area`);
}

export interface ViewportFitObservation {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly orientationPortrait: boolean;
  /** `client.nativeRect({x:0,y:0,width:390,height:844})`. */
  readonly nativeRect: NativeRect;
}

/** D3.1: the whole emulated portrait viewport is applied and lies inside the WebView. */
export function assertViewportFit(observation: ViewportFitObservation): void {
  assert.equal(observation.innerWidth, PORTRAIT_LINK_PROFILE.width,
    'Portrait innerWidth is exact');
  assert.equal(observation.innerHeight, PORTRAIT_LINK_PROFILE.height,
    'Portrait innerHeight is exact');
  // Chromium reports the emulated factor through a float (1.0000000186 for 1), so
  // compare within the viewport adapter's own 1e-6 tolerance.
  assert(Math.abs(observation.devicePixelRatio - (PORTRAIT_LINK_PROFILE.deviceScaleFactor ?? 1)) < 1e-6,
    'Portrait device pixel ratio is exact');
  assert.equal(observation.orientationPortrait, true,
    'The portrait orientation media query matches');
  assertNativeRect(observation.nativeRect, 'The emulated viewport');
}

export interface DisplayFrame {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** `wm size`; an override, when present, is the effective display size. */
export function parseWmSize(text: string): { readonly width: number; readonly height: number } {
  const read = (label: string): { width: number; height: number } | undefined => {
    const matches = [...text.matchAll(new RegExp(`^${label} size: (\\d+)x(\\d+)\\s*$`, 'gm'))];
    assert(matches.length <= 1, `wm size reports one ${label.toLowerCase()} size`);
    const [match] = matches;
    return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
  };
  const physical = read('Physical');
  assert(physical, 'wm size reports the physical size');
  const size = read('Override') ?? physical;
  assert(size.width > 0 && size.height > 0, 'wm size is positive');
  return size;
}

/**
 * Fail-closed navigation-bar frame from `dumpsys window`: the distinct
 * `type=navigationBars frame=[l,t][r,b]` entries spanning the display's right and
 * bottom edges must reduce to exactly one frame.
 */
export function parseNavigationBarFrame(dumpsys: string, wmSize: string): DisplayFrame {
  const size = parseWmSize(wmSize);
  const frames = new Map<string, DisplayFrame>();
  const pattern =
    /type=navigationBars\b[^\n]*?\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g;
  for (const match of dumpsys.matchAll(pattern)) {
    const [left, top, right, bottom] = match.slice(1, 5).map(Number) as
      [number, number, number, number];
    if (right !== size.width || bottom !== size.height) continue;
    frames.set(`${left},${top},${right},${bottom}`, { left, top, right, bottom });
  }
  assert.equal(frames.size, 1,
    `Exactly one navigation-bar frame spans the display edge (found ${frames.size})`);
  const [frame] = [...frames.values()];
  assert(frame!.left >= 0 && frame!.left < frame!.right && frame!.top >= 0 &&
    frame!.top < frame!.bottom, 'The navigation-bar frame is well formed');
  return frame!;
}

export interface PhysicalFooterReachReceipt {
  readonly navigationBar: DisplayFrame;
  readonly footer: NativeRect;
  readonly primary: NativeRect;
  readonly close: NativeRect;
  /** `elementFromPoint` at the primary button's CSS centre. */
  readonly primaryHit: HitResult;
  /** `elementFromPoint` at the footer Close button's CSS centre. */
  readonly closeHit: HitResult;
}

/** D3.4: both footer buttons sit wholly above the device navigation bar. */
export function assertPhysicalFooterReach(receipt: PhysicalFooterReachReceipt): void {
  assertNativeRect(receipt.footer, 'The footer');
  assertNativeRect(receipt.primary, 'The primary action');
  assertNativeRect(receipt.close, 'The Close action');
  assert(receipt.primary.bottomRight.y <= receipt.navigationBar.top,
    'The primary action is above the navigation bar');
  assert(receipt.close.bottomRight.y <= receipt.navigationBar.top,
    'The Close action is above the navigation bar');
  assert(receipt.primaryHit === 'self' || receipt.primaryHit === 'descendant',
    'The primary action is the hit target at its centre');
  assert(receipt.closeHit === 'self' || receipt.closeHit === 'descendant',
    'The Close action is the hit target at its centre');
}

/** The per-stage `profile-applied.json` payload. */
export interface AppliedProfileObservation {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly visualViewport: { readonly offsetTop: number; readonly height: number } | null;
  readonly coarsePointer: boolean;
  readonly maxTouchPoints: number;
  readonly platform: string | null;
  readonly orientationPortrait: boolean;
}

export function parseAppliedProfile(value: unknown): AppliedProfileObservation {
  const profile = object(value, 'Applied profile');
  return {
    innerWidth: numberField(profile, 'innerWidth'),
    innerHeight: numberField(profile, 'innerHeight'),
    devicePixelRatio: numberField(profile, 'devicePixelRatio'),
    visualViewport: visualViewportField(profile, 'visualViewport'),
    coarsePointer: booleanField(profile, 'coarsePointer'),
    maxTouchPoints: countField(profile, 'maxTouchPoints'),
    platform: nullableStringField(profile, 'platform'),
    orientationPortrait: booleanField(profile, 'orientationPortrait'),
  };
}

// User-card dialog model and navigation.

export interface PointerReceipt {
  readonly coarsePointer: boolean;
  readonly platform: string | null;
}

/** D4 pre-tap: Android's coarse-pointer dialog model applies under DESKTOP. */
export function assertCoarseAndroidPointer(receipt: PointerReceipt): void {
  assert.equal(receipt.coarsePointer, true, 'The WebView reports a coarse pointer');
  assert.equal(receipt.platform, 'android', 'Capacitor reports the Android platform');
}

export interface UserCardDialogEntry {
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly ariaModal: string | null;
  readonly visible: boolean;
  readonly containsCard: boolean;
  readonly containsName: boolean;
  readonly cardName: string | null;
  readonly inGlobalWrapper: boolean;
  readonly inConnectedBox: boolean;
}

export interface UserCardDialogObservation extends PointerReceipt {
  /** Every `[role="dialog"]` in the document. */
  readonly dialogCount: number;
  readonly dialogs: readonly UserCardDialogEntry[];
  readonly userCardCount: number;
  readonly globalWrapperCount: number;
  readonly darkBackdropCount: number;
  readonly visibleDarkBackdropCount: number;
  readonly transparentBackdropCount: number;
  readonly connectedBoxCount: number;
}

export function parseUserCardDialog(value: unknown): UserCardDialogObservation {
  const observation = object(value, 'User-card dialog');
  const dialogs = observation['dialogs'];
  assert(Array.isArray(dialogs), 'User-card dialogs are an array');
  const dialogCount = countField(observation, 'dialogCount');
  assert.equal(dialogs.length, dialogCount, 'Dialog entries match the count');
  return {
    dialogCount,
    dialogs: dialogs.map((raw: unknown, index: number): UserCardDialogEntry => {
      const dialog = object(raw, `Dialog ${index}`);
      return {
        role: nullableStringField(dialog, 'role'),
        ariaLabel: nullableStringField(dialog, 'ariaLabel'),
        ariaModal: nullableStringField(dialog, 'ariaModal'),
        visible: booleanField(dialog, 'visible'),
        containsCard: booleanField(dialog, 'containsCard'),
        containsName: booleanField(dialog, 'containsName'),
        cardName: nullableStringField(dialog, 'cardName'),
        inGlobalWrapper: booleanField(dialog, 'inGlobalWrapper'),
        inConnectedBox: booleanField(dialog, 'inConnectedBox'),
      };
    }),
    userCardCount: countField(observation, 'userCardCount'),
    globalWrapperCount: countField(observation, 'globalWrapperCount'),
    darkBackdropCount: countField(observation, 'darkBackdropCount'),
    visibleDarkBackdropCount: countField(observation, 'visibleDarkBackdropCount'),
    transparentBackdropCount: countField(observation, 'transparentBackdropCount'),
    connectedBoxCount: countField(observation, 'connectedBoxCount'),
    coarsePointer: booleanField(observation, 'coarsePointer'),
    platform: nullableStringField(observation, 'platform'),
  };
}

export function assertNoAnchoredPopover(
  observation: Pick<UserCardDialogObservation, 'connectedBoxCount'>,
): void {
  assert.equal(observation.connectedBoxCount, 0,
    'No anchored-popover container is rendered');
}

/** 582: exactly one visible dialog, and its text contains the user name. */
export function assertDialogNamesUser(observation: UserCardDialogObservation): void {
  assert.equal(observation.dialogCount, 1, 'Exactly one dialog is rendered');
  const [dialog] = observation.dialogs;
  assert(dialog!.visible, 'The dialog is visible');
  assert(dialog!.containsName, 'The dialog contains the exact user name');
}

/** 574 inside the dialog: the card shows the display name, not the MXID fallback. */
export function assertUserCardName(
  observation: UserCardDialogObservation,
  name: string,
): void {
  assert.equal(observation.userCardCount, 1, 'Exactly one user card is rendered');
  assert.equal(observation.dialogs[0]?.cardName, name,
    'The user card names the exact display name');
}

/** D4 positive model: one global modal User dialog holding the named user card. */
export function assertAndroidUserCardDialog(
  observation: UserCardDialogObservation,
  name: string,
): void {
  assert(name.length > 0, 'The expected user name is known');
  assertDialogNamesUser(observation);
  const [dialog] = observation.dialogs;
  assert.equal(dialog!.role, 'dialog', 'The card host has the dialog role');
  assert.equal(dialog!.ariaLabel, 'User', 'The dialog is labelled User');
  // aria-modal is recorded, not required: Angular CDK dialogs default ariaModal to
  // false and Trinity keeps that default, and the predecessor never asserts it.
  assert(dialog!.containsCard, 'The dialog contains the user card');
  assertUserCardName(observation, name);
  assert(dialog!.inGlobalWrapper, 'The dialog uses the global overlay wrapper');
  assert(!dialog!.inConnectedBox, 'The dialog is not an anchored popover');
  assert(observation.visibleDarkBackdropCount >= 1, 'A dark modal backdrop is visible');
  assert.equal(observation.transparentBackdropCount, 0,
    'No transparent popover backdrop is rendered');
  assertNoAnchoredPopover(observation);
  assertCoarseAndroidPointer(observation);
}

export interface NavigationMarker {
  readonly href: string;
  readonly timeOrigin: number;
  readonly historyLength: number;
}

export function parseNavigationMarker(value: unknown): NavigationMarker {
  const marker = object(value, 'Navigation marker');
  return {
    href: stringField(marker, 'href'),
    timeOrigin: numberField(marker, 'timeOrigin'),
    historyLength: countField(marker, 'historyLength'),
  };
}

/** Same document, same URL and no history entry: the card tap never navigated. */
export function assertNoNavigation(before: NavigationMarker, after: NavigationMarker): void {
  assert.deepEqual({
    href: after.href,
    timeOrigin: after.timeOrigin,
    historyLength: after.historyLength,
  }, {
    href: before.href,
    timeOrigin: before.timeOrigin,
    historyLength: before.historyLength,
  }, 'The user-card tap did not navigate');
}
