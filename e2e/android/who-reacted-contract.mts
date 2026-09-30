import assert from 'node:assert/strict';
import type { AccountViewportProfile } from './account-workspace-client.mts';
import type { WorkspaceRateLimitedJoin } from './account-workspace-fixtures.mts';
import type {
  ReactionDialogObservation, ReactionRowObservation, ShellRouteObservation,
} from './who-reacted-observer.mts';

/** Canonical bytes: the working tree, equal to the dd0cb53c blob (the issue's pin is current). */
export const WHO_REACTED_SOURCE = 'e2e/browser/journeys/conversations/reactions-who.spec.mts';
export const WHO_REACTED_SOURCE_SHA256 = 'dce976ac883e07e14850bfee43cf50050b1b1f334174ba742ca530e2b0dc9b8a';
export const WHO_REACTED_SOURCE_LINES = 737;
export const WHO_REACTED_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts': '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts': 'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/journeys/navigation.mts': '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
  'e2e/browser/support/settings-journey.mts': 'b645b7cb0ad697c8a2ec28cf74d0c5a74e0f103ea2ee1a51f8d0c3fad22fb813',
} as const;

export const WHO_REACTED_STAGE_IDS = ['pill-dialog', 'mobile-sheet'] as const;
export type WhoReactedStageId = (typeof WHO_REACTED_STAGE_IDS)[number];

interface Span { readonly from: number; readonly to: number }
export const WHO_REACTED_SPANS = {
  loginApi: { from: 32, to: 48 },
  joinWithRetry: { from: 51, to: 83 },
  seedReactedMessage: { from: 101, to: 225 },
  react: { from: 155, to: 170 },
  sendReactions: { from: 171, to: 207 },
  openRoom: { from: 227, to: 235 },
  fixtureAndRoom: { from: 32, to: 235 },
  general: { from: 241, to: 531 },
  mobileJourney: { from: 534, to: 709 },
  synthetic: { from: 647, to: 700 },
  pixelDefinition: { from: 723, to: 729 },
  mobileDefinition: { from: 731, to: 735 },
} as const satisfies Readonly<Record<string, Span>>;

export type WhoReactedHelper =
  | 'loginApi' | 'seedReactedMessage' | 'joinWithRetry' | 'react'
  | 'openRoom' | 'openSettingsFromRooms' | 'closeSettings';

/** Each helper's module and the assertion lines it owns on the Android path. */
export const WHO_REACTED_HELPERS = {
  loginApi: { module: WHO_REACTED_SOURCE, expectLines: [45], role: 'api-login' },
  seedReactedMessage: { module: WHO_REACTED_SOURCE, expectLines: [139, 149], role: 'fixture-room-and-target' },
  joinWithRetry: { module: WHO_REACTED_SOURCE, expectLines: [64], role: 'rate-limited-join' },
  react: { module: WHO_REACTED_SOURCE, expectLines: [169], role: 'reaction-send' },
  openRoom: { module: WHO_REACTED_SOURCE, expectLines: [232], role: 'room-readiness' },
  openSettingsFromRooms: { module: 'e2e/support/journeys/navigation.mts', expectLines: [19, 32], role: 'native-settings-open' },
  closeSettings: { module: 'e2e/support/journeys/navigation.mts', expectLines: [69, 84, 99], role: 'native-settings-close' },
} as const satisfies Readonly<Record<WhoReactedHelper, {
  readonly module: string; readonly expectLines: readonly number[]; readonly role: string;
}>>;

/** Browser-only spans and sites, retained in the predecessor and never Android claims. */
export const WHO_REACTED_EXCLUDED = {
  generalDesktopSpans: [[296, 306], [309, 317], [327, 345], [354, 388], [392, 400], [428, 471], [482, 505], [507, 524]],
  generalDesktopSites: 35,
  mobileDesktopSpans: [[543, 543], [704, 706]],
  mobileDesktopSites: [705],
  syntheticSites: [650, 651, 653, 654, 655, 656, 670, 682, 683, 685, 686, 687, 688],
  pixelDefinitionSpan: [718, 730],
  navigationDesktopSpans: [[37, 44], [104, 105]],
  desktopHelperCalls: [312, 316, 368, 372],
} as const;

export type WhoReactedSite =
  | { readonly kind: 'direct'; readonly line: number; readonly suffix: string }
  | {
      readonly kind: 'inherited';
      readonly helper: WhoReactedHelper;
      readonly line: number;
      readonly call: number;
      /** The line inside the helper where the site runs: a nested call or the helper's own site. */
      readonly via: number;
      /** 1-based iteration; 0 for a single execution. */
      readonly index: number;
      readonly suffix: string;
    };

const pad = (n: number): string => String(n).padStart(2, '0');
const range = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i + 1);
const direct = (line: number, suffix: string): WhoReactedSite => ({ kind: 'direct', line, suffix });
const inherited = (helper: WhoReactedHelper, line: number, call: number, via: number,
  index: number, suffix: string): WhoReactedSite =>
  ({ kind: 'inherited', helper, line, call, via, index, suffix });

/** Lines 119/130/139/142/149: 17 logins, the Room, 16 joins and the target (35). */
function fixtureSites(seed: number): readonly WhoReactedSite[] {
  return [
    inherited('loginApi', 45, seed, 119, 0, 'api-login-reader'),
    ...range(16).map((i) => inherited('loginApi', 45, seed, 130, i, `api-login-other-${pad(i)}`)),
    inherited('seedReactedMessage', 139, seed, 139, 0, 'room-created'),
    ...range(16).map((i) => inherited('joinWithRetry', 64, seed, 142, i, `join-other-${pad(i)}`)),
    inherited('seedReactedMessage', 149, seed, 149, 0, 'target-sent'),
  ];
}

/** Reaction n (1–36) runs at `react` call 172 (1), 176 (2–17), 178 (18) or 201 (19–36). */
export const reactionVia = (n: number): number => (n === 1 ? 172 : n <= 17 ? 176 : n === 18 ? 178 : 201);
function reactionSites(call: number): readonly WhoReactedSite[] {
  return range(36).map((n) => inherited('react', 169, call, reactionVia(n), n, `reaction-${pad(n)}`));
}

function settingsSites(mode: 'light' | 'dark', open: number, poll: number, close: number,
  room: number): readonly WhoReactedSite[] {
  return [
    inherited('openSettingsFromRooms', 19, open, 19, 0, `${mode}-rooms-route`),
    inherited('openSettingsFromRooms', 32, open, 32, 0, `${mode}-settings-sections`),
    direct(poll, `${mode}-mode`),
    inherited('closeSettings', 69, close, 69, 0, `${mode}-section-unwound`),
    inherited('closeSettings', 84, close, 84, 0, `${mode}-rooms-restored`),
    inherited('closeSettings', 99, close, 99, 0, `${mode}-settings-detached`),
    inherited('openRoom', 232, room, 232, 0, `${mode}-room-open`),
  ];
}

const SITES: Readonly<Record<WhoReactedStageId, readonly WhoReactedSite[]>> = {
  'pill-dialog': [
    ...fixtureSites(246),
    inherited('openRoom', 232, 253, 232, 0, 'room-open'),
    direct(256, 'target-visible'),
    ...reactionSites(264),
    direct(265, 'thumbs-count'), direct(271, 'group-count'), direct(278, 'thumbs-summary'),
    direct(320, 'dialog-visible'), direct(348, 'dialog-total'), direct(351, 'close-visible'),
    direct(391, 'key-count'), direct(401, 'long-reactor-listed'), direct(404, 'thumbs-reactors'),
    direct(405, 'long-reactor-ellipsis'), direct(411, 'long-reactor-overflow'),
    direct(420, 'detail-overflow'), direct(476, 'heart-pressed'), direct(477, 'heart-reactors'),
    direct(529, 'dialog-dismissed'),
  ],
  'mobile-sheet': [
    ...fixtureSites(545),
    inherited('openRoom', 232, 551, 232, 0, 'room-open'),
    direct(553, 'target-visible'),
    ...reactionSites(557),
    direct(558, 'thumbs-count'), direct(562, 'group-count'),
    ...settingsSites('light', 569, 572, 573, 574),
    direct(583, 'light-dialog-visible'), direct(584, 'sheet-class'),
    direct(597, 'sheet-left-bound'), direct(598, 'sheet-right-bound'),
    direct(599, 'sheet-bottom-attached'), direct(606, 'light-dialog-closed'),
    ...settingsSites('dark', 609, 612, 613, 614),
    direct(618, 'dark-dialog-visible'), direct(626, 'directory-overflow'),
    direct(633, 'detail-overflow'), direct(641, 'last-key-pressed'),
    direct(642, 'directory-scrolled'), direct(645, 'last-key-reactors'),
    direct(703, 'dialog-dismissed'), direct(707, 'composer-visible'),
  ],
};

const TITLES: Readonly<Record<WhoReactedStageId, string>> = {
  'pill-dialog': 'names the reactors on the pill and lists them all in the dialog',
  'mobile-sheet': 'uses touch selection and native Back to dismiss the reaction sheet',
};
const SOURCES: Readonly<Record<WhoReactedStageId, string>> = {
  'pill-dialog': `${WHO_REACTED_SOURCE}:241-531`,
  'mobile-sheet': `${WHO_REACTED_SOURCE}:731-735`,
};

export type WhoReactedAssertion = `who-reacted.${WhoReactedStageId}.${string}`;
export interface WhoReactedStage {
  readonly id: WhoReactedStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly WhoReactedSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly WhoReactedAssertion[];
}

export const WHO_REACTED_STAGES: readonly WhoReactedStage[] = WHO_REACTED_STAGE_IDS.map((id) => ({
  id,
  source: SOURCES[id],
  title: TITLES[id],
  sites: SITES[id],
  expectedAssertionRecords: SITES[id].length,
  assertions: SITES[id].map(({ suffix }): WhoReactedAssertion => `who-reacted.${id}.${suffix}`),
}));

export const WHO_REACTED_STAGE_RECORDS = { 'pill-dialog': 88, 'mobile-sheet': 103 } as const;
export const WHO_REACTED_ASSERTION_RECORDS = 191;

/** A direct site orders by its line; an inherited site by its call, then via, then iteration. */
export function siteOrderKey(site: WhoReactedSite): readonly [number, number, number, number] {
  return site.kind === 'direct' ? [site.line, 1, 0, 0] : [site.call, 0, site.via, site.index];
}

const entryFor = (stageId: WhoReactedStageId): WhoReactedStage => {
  const entry = WHO_REACTED_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown who-reacted stage ${stageId}`);
  return entry;
};

const KEBAB = /^[a-z][a-z0-9-]*$/u;

function validateContract(): void {
  assert.deepEqual(WHO_REACTED_STAGES.map(({ id }) => id), [...WHO_REACTED_STAGE_IDS],
    'Who-reacted stages keep source order');
  let sum = 0;
  for (const stage of WHO_REACTED_STAGES) {
    assert.equal(stage.sites.length, WHO_REACTED_STAGE_RECORDS[stage.id],
      `${stage.id} owns exactly ${WHO_REACTED_STAGE_RECORDS[stage.id]} records`);
    assert.equal(stage.expectedAssertionRecords, stage.sites.length,
      `${stage.id} expected records equal its sites`);
    sum += stage.sites.length;
    const span = stage.id === 'pill-dialog' ? WHO_REACTED_SPANS.general : WHO_REACTED_SPANS.mobileJourney;
    const excluded: readonly (readonly [number, number])[] = stage.id === 'pill-dialog'
      ? WHO_REACTED_EXCLUDED.generalDesktopSpans
      : [...WHO_REACTED_EXCLUDED.mobileDesktopSpans, [WHO_REACTED_SPANS.synthetic.from, WHO_REACTED_SPANS.synthetic.to]];
    const suffixes = new Set<string>();
    let previous: readonly number[] = [0, 0, 0, 0];
    for (const site of stage.sites) {
      const key = siteOrderKey(site);
      const at = key.findIndex((value, i) => value !== previous[i]);
      const increasing = at >= 0 && key[at]! > previous[at]!;
      assert(increasing, `${stage.id} site ${site.suffix} is out of order`);
      previous = key;
      assert.match(site.suffix, KEBAB, `${site.suffix} is a kebab-case suffix`);
      assert(!suffixes.has(site.suffix), `${stage.id} suffix ${site.suffix} is unique`);
      suffixes.add(site.suffix);
      if (site.kind === 'direct') {
        assert(site.line >= span.from && site.line <= span.to, `${stage.id} direct ${site.line} lies in its span`);
        for (const [from, to] of excluded)
          assert(!(site.line >= from && site.line <= to), `${stage.id} direct ${site.line} is not excluded`);
      } else {
        assert((WHO_REACTED_HELPERS[site.helper].expectLines as readonly number[]).includes(site.line),
          `${site.helper} owns line ${site.line}`);
      }
    }
  }
  assert.equal(sum, WHO_REACTED_ASSERTION_RECORDS, 'Who-reacted owns exactly 191 records');
}

validateContract();

export function whoReactedAssertion(stageId: WhoReactedStageId, suffix: string): WhoReactedAssertion {
  const entry = entryFor(stageId);
  const identity: WhoReactedAssertion = `who-reacted.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertWhoReactedRecords(stageId: WhoReactedStageId, actual: readonly string[]): void {
  assert.deepEqual(actual, entryFor(stageId).assertions, `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for a parity suffix. */
export function assertWhoReactedReceiptName(name: string): void {
  assert.match(name, KEBAB, `Receipt name ${name} is kebab-case`);
  const suffixes = new Set(WHO_REACTED_STAGES.flatMap((entry) => entry.sites.map((site) => site.suffix)));
  assert(!suffixes.has(name), `Receipt ${name} is not a parity suffix`);
}

/** The Android Playwright project's default viewport plus the describe's `hasTouch` (239). */
export const GENERAL_TOUCH_PROFILE: AccountViewportProfile = {
  width: 1280, height: 720, isMobile: false, hasTouch: true, deviceScaleFactor: 1,
};
/** The Pixel 5 describe's Android `test.use` (713–717); its UA and DPR are non-Android only. */
export const MOBILE_SHEET_PROFILE: AccountViewportProfile = {
  width: 393, height: 851, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
};
export const WHO_REACTED_PROFILES: Readonly<Record<WhoReactedStageId, AccountViewportProfile>> = {
  'pill-dialog': GENERAL_TOUCH_PROFILE,
  'mobile-sheet': MOBILE_SHEET_PROFILE,
};

/** `testResourceId(role) + suffix` (245, 548): the Node namespace's `role()` is its implementation. */
export const RUN_TAGS = {
  'pill-dialog': { role: 'run', suffix: 'w' },
  'mobile-sheet': { role: 'mobile', suffix: 'm' },
} as const satisfies Readonly<Record<WhoReactedStageId, { readonly role: string; readonly suffix: string }>>;
export const roomNameOf = (runId: string): string => `Who reacted ${runId}`;
export const bodyOf = (runId: string): string => `react to me ${runId}`;
export const targetTxnOf = (runId: string): string => `who-${runId}`;
/** The predecessor's long localpart (108), shown as a display name (spec D2). */
export const longReactorNameOf = (runId: string): string => `who-other-${runId}-${'x'.repeat(36)}`;
const STAGE_ROLE_PREFIX: Readonly<Record<WhoReactedStageId, string>> = { 'pill-dialog': 'pd', 'mobile-sheet': 'ms' };
export const readerRole = (stage: WhoReactedStageId): string => `${STAGE_ROLE_PREFIX[stage]}-reader`;
export const otherRole = (stage: WhoReactedStageId, n: number): string =>
  `${STAGE_ROLE_PREFIX[stage]}-other-${String(n).padStart(2, '0')}`;

export const REACTION_KEYS = ['❤️', '😂', '😮', '😢', '😡', '🚀', '✅', '❌', '👏', '🙌',
  '🔥', '💯', '🎯', '✨', '💡', '🌈', '🍀', '🌟'] as const;
/** At most 8 new timeline events per sync batch: below Synapse's default limit of 10 (spec D5). */
export const REACTION_GROUP = 8;
/** Cumulative rendered state after groups 1–4. */
export const GATES = [
  { thumbs: 8, groups: 1 }, { thumbs: 16, groups: 1 }, { thumbs: 17, groups: 8 }, { thumbs: 17, groups: 16 },
] as const;

export interface PlannedReaction {
  /** 1-based position; the record is `reaction-NN`. */
  readonly n: number;
  readonly key: string;
  /** 0 is the reader; 1–16 are the others in creation order (1 is the long reactor). */
  readonly sender: number;
  readonly txn: string;
}

/** Lines 171–206 exactly: the reader's 👍, sixteen 👍, other 1's 🎉, then 18 keys. */
export function reactionPlan(runId: string): readonly PlannedReaction[] {
  return [
    { n: 1, key: '👍', sender: 0, txn: `r1-${runId}` },
    ...Array.from({ length: 16 }, (_, i) => ({ n: i + 2, key: '👍', sender: i + 1, txn: `r${i + 2}-${runId}` })),
    { n: 18, key: '🎉', sender: 1, txn: `r10-${runId}` },
    ...REACTION_KEYS.map((key, i) => ({ n: 19 + i, key, sender: ((i + 1) % 16) + 1, txn: `group${i}-${runId}` })),
  ];
}

/* ------------------------------------------------------------------ asserters */

/** A timeline or state event as the fixture's relations and room reads return it. */
export interface RoomEvent {
  readonly event_id?: string;
  readonly type: string;
  readonly sender?: string;
  readonly state_key?: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly unsigned?: Readonly<Record<string, unknown>>;
}

export function assertApiLogin(account: { readonly userId: string; readonly username: string }): void {
  assert.equal(account.userId, `@${account.username}:localhost`, 'API login returned the exact user');
}
export function assertRoomCreated(roomId: string): void {
  assert.match(roomId, /^![^:\s]+:\S+$/u, 'Room id is a Matrix room id');
}
export function assertJoined(r: WorkspaceRateLimitedJoin): void {
  const ok = r.status >= 200 && r.status <= 299 && r.attempts >= 1 && r.attempts <= 5
    && r.retryAfterMs.length === r.attempts - 1;
  assert.ok(ok, 'The member joined within five attempts');
}
export function assertEventSent(eventId: string): void {
  assert.match(eventId, /^\$\S+$/u, 'The sent event id is a Matrix event id');
}

const latestState = (events: readonly RoomEvent[], type: string, stateKey = ''): RoomEvent | undefined =>
  events.filter((e) => e.type === type && (e.state_key ?? '') === stateKey).at(-1);

export interface ArrangementExpectation {
  readonly readerId: string;
  readonly otherIds: readonly string[];
  readonly targetId: string;
  readonly runId: string;
}
export function assertArrangement(events: readonly RoomEvent[], e: ArrangementExpectation): void {
  assert.ok(events.some((event) => event.type === 'm.room.create'), 'The Room has an m.room.create event');
  const messages = events.filter((event) => event.type === 'm.room.message');
  assert.equal(messages.length, 1, 'The Room holds exactly the target message');
  const [target] = messages;
  assert.equal(target?.event_id, e.targetId, 'The Room holds exactly the target message');
  assert.equal(target?.sender, e.readerId, 'The reader sent the target');
  assert.equal(target?.content['body'], bodyOf(e.runId), 'The target carries the arranged body');
  assert.equal(latestState(events, 'm.room.join_rules')?.content['join_rule'], 'public', 'The Room is public');
  const latestMembers = new Map<string, RoomEvent>();
  for (const event of events) if (event.type === 'm.room.member' && event.state_key !== undefined) {
    latestMembers.set(event.state_key, event);
  }
  const joined = [...latestMembers].filter(([, event]) => event.content['membership'] === 'join').map(([key]) => key);
  assert.deepEqual([...joined].sort(), [e.readerId, ...e.otherIds].sort(), 'The Room has exactly 17 joined members');
  const first = e.otherIds[0];
  assert.equal(first === undefined ? undefined : latestMembers.get(first)?.content['displayname'],
    longReactorNameOf(e.runId), "The long reactor's display name is the arranged long name");
}

export interface ReactionsExpectation {
  readonly plan: readonly PlannedReaction[];
  readonly ids: readonly string[];
  readonly readerId: string;
  readonly otherIds: readonly string[];
  readonly targetId: string;
}
export function assertReactionsArranged(events: readonly RoomEvent[], e: ReactionsExpectation):
  { readonly reactions: number; readonly thumbs: number; readonly keys: number; readonly readerIncluded: boolean } {
  assert.equal(events.length, 36, 'Exactly 36 reactions are related to the target');
  const keyOf = (event: RoomEvent): string => String((event.content['m.relates_to'] as { key?: unknown } | undefined)?.key);
  for (const event of events) {
    assert.equal(event.type, 'm.reaction', 'Every related event is an m.reaction');
    assert.ok(event.unsigned?.['redacted_because'] === undefined, 'Every reaction is unredacted');
    assert.deepEqual(event.content['m.relates_to'],
      { rel_type: 'm.annotation', event_id: e.targetId, key: keyOf(event) }, 'Every reaction annotates the target');
  }
  assert.deepEqual(new Set(events.map((event) => event.event_id)), new Set(e.ids), 'The reactions are exactly the recorded ids');
  const thumbSenders = events.filter((event) => keyOf(event) === '👍').map((event) => event.sender);
  assert.equal(new Set(thumbSenders).size, 17, 'The 👍 reactions come from 17 distinct senders');
  assert.equal(thumbSenders.length, 17, 'The 👍 reactions come from 17 distinct senders');
  assert.ok(thumbSenders.includes(e.readerId), 'The reader is among the 👍 senders');
  const keys = new Set(events.map(keyOf));
  assert.equal(keys.size, 20, 'The reactions use 20 keys');
  const everyone = new Set([e.readerId, ...e.otherIds]);
  for (const planned of e.plan) {
    const sender = planned.sender === 0 ? e.readerId : e.otherIds[planned.sender - 1];
    const senders = new Set(events.filter((event) => keyOf(event) === planned.key).map((event) => event.sender));
    if (planned.key === '👍') assert.deepEqual(senders, everyone, 'The 👍 is sent by the planned sender set');
    else assert.ok(sender !== undefined && senders.has(sender), `Key ${planned.key} is sent by its planned sender`);
  }
  return { reactions: 36, thumbs: 17, keys: 20, readerIncluded: true };
}

export function assertTargetRow(row: Pick<ReactionRowObservation, 'rows' | 'exactEvent'>,
  message = 'Exactly one reconciled target row is rendered and it is the arranged event'): void {
  assert.equal(row.rows, 1, message);
  assert.ok(row.exactEvent, message);
}
export function assertGate(row: ReactionRowObservation, gate: (typeof GATES)[number]): void {
  assertTargetRow(row, 'The target row is still rendered and still the arranged event');
  assert.equal(row.thumbsCount, String(gate.thumbs), `The cumulative 👍 count is ${gate.thumbs}`);
  assert.equal(row.pills, gate.groups, `The cumulative groups are ${gate.groups}`);
}
export function assertThumbsCount(row: ReactionRowObservation): void {
  assert.equal(row.thumbsPills, 1, 'One 👍 pill is rendered');
  assert.equal(row.thumbsCount, '17', 'The 👍 count is 17');
}
export function assertGroupCount(row: ReactionRowObservation): void {
  assert.equal(row.pills, 20, 'The row renders 20 reaction groups');
}
export function assertThumbsSummary(row: ReactionRowObservation): void {
  assert.ok(row.thumbsPills === 1 && row.summaryMatches, 'The 👍 pill names its reactors: reacted by You first');
}

type Dialog = ReactionDialogObservation;
export function assertDialogVisible(d: Dialog): void {
  assert.equal(d.dialogs, 1, 'There is one visible Reactions dialog');
}
export function assertDialogTotal(d: Dialog): void {
  assert.equal(d.total, '36 total', 'The dialog totals 36 total');
}
export function assertCloseVisible(d: Dialog): void {
  assert.ok(d.closeVisible, 'The close control is visible');
}
export function assertKeyCount(d: Dialog): void {
  assert.equal(d.keys, 20, 'The dialog lists 20 keys');
}
export function assertLongReactorListed(d: Dialog): void {
  assert.ok(d.listContainsLong, "The long reactor's name is listed");
}
export function assertReactors(d: Dialog, n: number): void {
  assert.equal(d.reactors, n, `The detail lists ${n} reactors`);
}
export function assertLongReactorEllipsis(d: Dialog): void {
  assert.ok(d.longName.found, 'The long reactor name is rendered whole in its own element');
  assert.equal(d.longName.textOverflow, 'ellipsis', 'The long reactor name uses text-overflow: ellipsis');
}
export function assertLongReactorOverflow(d: Dialog): void {
  assert.ok((d.longName.overflow ?? 0) > 0, 'The long reactor name actually overflows its box');
}
export function assertDetailOverflow(d: Dialog): void {
  assert.ok((d.detailOverflow ?? 0) > 0, 'The reactor detail scrolls vertically');
}
export function assertKeyPressed(d: Dialog, key: string): void {
  assert.deepEqual(d.pressedKeys, [key], `Only ${key} is pressed`);
}
export function assertDialogDismissed(d: Dialog): void {
  assert.equal(d.dialogs, 0, 'The Reactions dialog is dismissed');
}
export function assertSheetClass(d: Dialog): void {
  assert.ok(d.sheetHost, 'The dialog host carries the sheet class');
}
export function assertSheetLeft(d: Dialog): void {
  assert.ok(d.box !== null && d.box.left >= 0, 'The sheet starts inside the viewport');
}
export function assertSheetRight(d: Dialog): void {
  assert.ok(d.box !== null && d.box.right <= d.innerWidth + 1, 'The sheet ends inside the viewport');
}
export function assertSheetBottom(d: Dialog): void {
  assert.ok(d.box !== null && Math.abs(d.box.bottom - d.innerHeight) < 0.5, 'The sheet is bottom-attached');
}
export function assertDirectoryOverflow(d: Dialog): void {
  assert.ok(d.directory !== null && d.directory.scrollWidth > d.directory.clientWidth,
    'The key directory overflows horizontally');
}
export function assertLastKeyPressed(d: Dialog): void {
  assert.ok(d.lastKey.pressed, 'The last key is pressed');
}
export function assertDirectoryScrolled(d: Dialog): void {
  assert.ok(d.directory !== null && d.directory.scrollLeft > 0, 'The key directory scrolled to the last key');
}
export function assertComposerVisible(v: Pick<ReactionRowObservation, 'composers' | 'composerVisible'>): void {
  assert.equal(v.composers, 1, 'One composer is rendered');
  assert.ok(v.composerVisible, 'The composer is visible');
}

type Route = ShellRouteObservation;
export function assertRoomsRoute(r: Route, userId: string): void {
  assert.ok(r.path.startsWith('/rooms') && r.account === userId, 'Account-qualified Rooms route');
}
export function assertSettingsSections(r: Route): void {
  assert.ok(r.path.startsWith('/settings') && r.sectionsVisible, 'The Settings sections are visible');
}
export function assertMode(r: Route, mode: 'dark' | 'light'): void {
  assert.equal(r.dark, mode === 'dark', `The Appearance mode is ${mode}`);
}
export function assertSectionUnwound(r: Route): void {
  assert.ok(r.path === '/settings' || r.path.startsWith('/rooms'), 'The Settings section unwound');
}
export function assertSettingsDetached(r: Route): void {
  assert.equal(r.settingsHosts, 0, 'The Settings host is detached');
}
