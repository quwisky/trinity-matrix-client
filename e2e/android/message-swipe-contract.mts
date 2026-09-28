import assert from 'node:assert/strict';

export const MESSAGE_SWIPE_SOURCE =
  'e2e/browser/journeys/conversations/message-swipe.spec.mts';
/** The predecessor at the issue's pin, which this branch carries unchanged. */
export const MESSAGE_SWIPE_SOURCE_SHA256 =
  '435f360188e627c7942e29988f62dd4654955317eb23f0980adabea23fd7bdb4';
export const MESSAGE_SWIPE_SOURCE_LINES = 626;

export const MESSAGE_SWIPE_SHARED_SOURCE_SHA256 = {
  'e2e/support/journeys/navigation.mts':
    '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
  'e2e/support/touch-platform.mts':
    '8bbf71ffc3e83010599c30ed5c2c347972f5a7b559daa6394613e33af2c43ee1',
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const MESSAGE_SWIPE_STAGE_IDS = [
  'edit-own',
  'reply-other',
  'partial-affordance',
  'progressive-feedback',
  'off-inert',
  'left-direction',
  'left-strip-geometry',
  'vertical-abandon',
  'vertical-scroll',
  'edge-dead-zones',
  'drawer-left',
  'drawer-off',
  'drawer-right',
  'live-setting',
] as const;

export type MessageSwipeStageId = (typeof MESSAGE_SWIPE_STAGE_IDS)[number];

export interface MessageSwipeSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * Owned predecessor spans. `drawer-left` and `drawer-off` are the two
 * iterations of the one parameterised definition at 537–566.
 */
export const MESSAGE_SWIPE_SPANS = {
  constants: { from: 35, to: 38 },
  openRoom: { from: 41, to: 156 },
  longRoom: { from: 122, to: 141 },
  swipeRow: { from: 158, to: 172 },
  definitions: {
    'edit-own': { from: 180, to: 191 },
    'reply-other': { from: 193, to: 205 },
    'partial-affordance': { from: 207, to: 243 },
    'progressive-feedback': { from: 245, to: 326 },
    'off-inert': { from: 328, to: 339 },
    'left-direction': { from: 341, to: 365 },
    'left-strip-geometry': { from: 367, to: 420 },
    'vertical-abandon': { from: 422, to: 446 },
    'vertical-scroll': { from: 448, to: 490 },
    'edge-dead-zones': { from: 492, to: 535 },
    'drawer-left': { from: 537, to: 566 },
    'drawer-off': { from: 537, to: 566 },
    'drawer-right': { from: 568, to: 591 },
    'live-setting': { from: 593, to: 624 },
  },
} as const satisfies {
  readonly constants: MessageSwipeSpan;
  readonly openRoom: MessageSwipeSpan;
  readonly longRoom: MessageSwipeSpan;
  readonly swipeRow: MessageSwipeSpan;
  readonly definitions: Readonly<Record<MessageSwipeStageId, MessageSwipeSpan>>;
};

/**
 * Helpers whose own `expect` lines an inherited site expands. `openRoom`
 * reaches 127 only for a long Room; the navigation helpers are expanded along
 * their Android branch only.
 */
export const MESSAGE_SWIPE_HELPERS = {
  openRoom: {
    module: MESSAGE_SWIPE_SOURCE,
    expectLines: [112, 118, 127],
    role: 'room-readiness',
  },
  openSettingsSection: {
    module: 'e2e/support/journeys/navigation.mts',
    expectLines: [19, 32, 59],
    role: 'native-settings-open',
  },
  closeSettings: {
    module: 'e2e/support/journeys/navigation.mts',
    expectLines: [69, 84, 99],
    role: 'native-settings-close',
  },
} as const satisfies Readonly<Record<string, {
  readonly module: string;
  readonly expectLines: readonly number[];
  readonly role: string;
}>>;

export type MessageSwipeHelper = keyof typeof MESSAGE_SWIPE_HELPERS;

export type MessageSwipeSite =
  | { readonly line: number; readonly suffix: string; readonly kind: 'direct' }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageSwipeHelper;
      readonly call: number;
    };

const room = (call: number, long = false): readonly MessageSwipeSite[] => [
  { line: 112, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call },
  { line: 118, suffix: 'encryption-banner', kind: 'inherited', helper: 'openRoom', call },
  ...(long
    ? [{ line: 127, suffix: 'history-loaded', kind: 'inherited', helper: 'openRoom', call } as const]
    : []),
];
const direct = (line: number, suffix: string): MessageSwipeSite =>
  ({ line, suffix, kind: 'direct' });
const drawerLoop = (): readonly MessageSwipeSite[] => [
  ...room(545),
  direct(555, 'drawer-initially-hidden'),
  direct(561, 'drawer-opened'),
  direct(564, 'drawer-closed'),
];

const SITES: Readonly<Record<MessageSwipeStageId, readonly MessageSwipeSite[]>> = {
  'edit-own': [...room(184), direct(188, 'editing')],
  'reply-other': [...room(197), direct(201, 'replying')],
  'partial-affordance': [
    ...room(211),
    direct(234, 'own-affordance-visible'),
    direct(238, 'own-edit-affordance'),
    direct(242, 'other-reply-affordance'),
  ],
  'progressive-feedback': [
    ...room(253),
    direct(309, 'partial-opacity-positive'),
    direct(311, 'partial-opacity-below-one'),
    direct(314, 'armed-opacity-one'),
    direct(317, 'armed-scale-changed'),
    direct(318, 'armed-colour-changed'),
  ],
  'off-inert': [...room(333), direct(335, 'no-affordance'), direct(338, 'no-banner')],
  'left-direction': [
    ...room(345),
    direct(349, 'right-drag-rejected'),
    direct(361, 'left-drag-replying'),
  ],
  'left-strip-geometry': [
    ...room(377),
    direct(411, 'icon-past-row-end'),
    direct(412, 'icon-inside-original-row'),
  ],
  'vertical-abandon': [
    ...room(426, true),
    direct(440, 'no-banner'),
    direct(441, 'no-drag-style'),
  ],
  'vertical-scroll': [
    ...room(459, true),
    direct(488, 'timeline-moved'),
    direct(489, 'no-banner'),
  ],
  'edge-dead-zones': [
    ...room(500),
    direct(508, 'left-edge-no-banner'),
    direct(516, 'inset-control-replying'),
    direct(523, 'right-edge-drawer-hidden'),
    direct(532, 'inset-drawer-visible'),
  ],
  'drawer-left': drawerLoop(),
  'drawer-off': drawerLoop(),
  'drawer-right': [
    ...room(572),
    direct(575, 'drawer-initially-hidden'),
    direct(583, 'drawer-opened'),
    direct(587, 'row-swipe-suppressed'),
    direct(590, 'drawer-closed'),
  ],
  'live-setting': [
    ...room(599),
    direct(600, 'initially-no-affordance'),
    { line: 19, suffix: 'settings-rooms-route', kind: 'inherited', helper: 'openSettingsSection', call: 605 },
    { line: 32, suffix: 'settings-sections-visible', kind: 'inherited', helper: 'openSettingsSection', call: 605 },
    { line: 59, suffix: 'settings-detail-ready', kind: 'inherited', helper: 'openSettingsSection', call: 605 },
    { line: 69, suffix: 'settings-section-unwound', kind: 'inherited', helper: 'closeSettings', call: 612 },
    { line: 84, suffix: 'rooms-route-restored', kind: 'inherited', helper: 'closeSettings', call: 612 },
    { line: 99, suffix: 'settings-detached', kind: 'inherited', helper: 'closeSettings', call: 612 },
    direct(613, 'settings-dialog-hidden'),
    direct(614, 'no-settings-path'),
    direct(621, 'affordance-live'),
  ],
};

const TITLES: Readonly<Record<MessageSwipeStageId, string>> = {
  'edit-own': 'swiping your own message opens the editor for it',
  'reply-other': "swiping someone else's message starts a reply to it",
  'partial-affordance': 'shows which action it will take, part-way through the drag',
  'progressive-feedback': 'the action fades and grows in as the drag approaches committing',
  'off-inert': 'does nothing at all while the setting is off',
  'left-direction': 'follows the direction it was set to, and only that one',
  'left-strip-geometry': 'the affordance waits in the strip the row uncovers',
  'vertical-abandon': 'a drag that turns vertical abandons the action',
  'vertical-scroll': 'a vertical drag still scrolls the timeline',
  'edge-dead-zones': 'refuses to start from either screen edge',
  'drawer-left': 'leaves the drawer gesture working with the setting left',
  'drawer-off': 'leaves the drawer gesture working with the setting off',
  'drawer-right': 'leaves the drawer gesture working',
  'live-setting': 'takes effect as soon as it is changed, with no reload',
};

/** The predecessor's `openRoom` tag, direction and filler per definition. */
export type SwipeSetting = 'right' | 'left' | 'off';

export interface MessageSwipeArrangement {
  readonly tag: string;
  /** `null` is the predecessor's "no seed": the product default, Off. */
  readonly seed: 'right' | 'left' | null;
  readonly filler: 0 | 30;
}

export const MESSAGE_SWIPE_ARRANGEMENTS: Readonly<Record<MessageSwipeStageId, MessageSwipeArrangement>> = {
  'edit-own': { tag: 'e', seed: 'right', filler: 0 },
  'reply-other': { tag: 'r', seed: 'right', filler: 0 },
  'partial-affordance': { tag: 'a', seed: 'right', filler: 0 },
  'progressive-feedback': { tag: 'p', seed: 'right', filler: 0 },
  'off-inert': { tag: 'o', seed: null, filler: 0 },
  'left-direction': { tag: 'l', seed: 'left', filler: 0 },
  'left-strip-geometry': { tag: 'g', seed: 'left', filler: 0 },
  'vertical-abandon': { tag: 'v', seed: 'right', filler: 30 },
  'vertical-scroll': { tag: 's', seed: 'right', filler: 30 },
  'edge-dead-zones': { tag: 'd', seed: 'right', filler: 0 },
  'drawer-left': { tag: 'l', seed: 'left', filler: 0 },
  'drawer-off': { tag: 'o', seed: null, filler: 0 },
  'drawer-right': { tag: 'w', seed: 'right', filler: 0 },
  'live-setting': { tag: 'c', seed: null, filler: 0 },
};

export type MessageSwipeAssertion = `message-swipe.${MessageSwipeStageId}.${string}`;

export interface MessageSwipeStage {
  readonly id: MessageSwipeStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessageSwipeSite[];
  readonly arrangement: MessageSwipeArrangement;
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageSwipeAssertion[];
}

export const MESSAGE_SWIPE_STAGES: readonly MessageSwipeStage[] =
  MESSAGE_SWIPE_STAGE_IDS.map((id) => {
    const span = MESSAGE_SWIPE_SPANS.definitions[id];
    const sites = SITES[id];
    return {
      id,
      source: `${MESSAGE_SWIPE_SOURCE}:${span.from}-${span.to}`,
      title: TITLES[id],
      sites,
      arrangement: MESSAGE_SWIPE_ARRANGEMENTS[id],
      expectedAssertionRecords: sites.length,
      assertions: sites.map(({ suffix }): MessageSwipeAssertion => `message-swipe.${id}.${suffix}`),
    };
  });

export const MESSAGE_SWIPE_ASSERTION_RECORDS = 74;
export const MESSAGE_SWIPE_DIRECT = 38;
export const MESSAGE_SWIPE_INHERITED = 36;
/** Two Room readiness sites per call (28), two long-Room pagination sites and six navigation sites. */
export const MESSAGE_SWIPE_HELPER_COUNTS = {
  openRoom: 30,
  openSettingsSection: 3,
  closeSettings: 3,
} as const satisfies Readonly<Record<MessageSwipeHelper, number>>;

/** Direct sites order by line; a helper call runs before a later matcher, its own lines in order. */
export function siteOrderKey(site: MessageSwipeSite): readonly [number, number, number] {
  return site.kind === 'direct' ? [site.line, 1, 0] : [site.call, 0, site.line];
}

function after(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

function within(line: number, span: MessageSwipeSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_SWIPE_STAGES.map(({ id }) => id), [...MESSAGE_SWIPE_STAGE_IDS],
    'Message-swipe stages keep source order');
  const sites = MESSAGE_SWIPE_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_SWIPE_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_SWIPE_ASSERTION_RECORDS, 'Message-swipe owns exactly 74 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length, MESSAGE_SWIPE_DIRECT,
    'Message-swipe owns exactly 38 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length, MESSAGE_SWIPE_INHERITED,
    'Message-swipe owns exactly 36 inherited sites');
  assert.equal(new Set(identities).size, MESSAGE_SWIPE_ASSERTION_RECORDS,
    'Message-swipe identities are globally unique');
  for (const [helper, expected] of Object.entries(MESSAGE_SWIPE_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) => site.kind === 'inherited' && site.helper === helper).length,
      expected, `${helper} expands exactly ${expected} times`);
  }
  for (const entry of MESSAGE_SWIPE_STAGES) {
    const span = MESSAGE_SWIPE_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(`^message-swipe\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
        `${identity} is a stage-local identity`);
    }
    let previous: readonly number[] = [0, 0, 0];
    for (const site of entry.sites) {
      const key = siteOrderKey(site);
      assert(after(key, previous), `${entry.id}.${site.suffix} keeps source order`);
      previous = key;
      if (site.kind === 'direct') {
        assert(within(site.line, span), `${entry.id}.${site.suffix} lies inside its definition`);
      } else {
        const lines: readonly number[] = MESSAGE_SWIPE_HELPERS[site.helper].expectLines;
        assert(lines.includes(site.line), `${entry.id}.${site.suffix} expands a ${site.helper} line`);
        assert(within(site.call, span), `${entry.id}.${site.suffix} call lies inside its definition`);
      }
    }
    const long = entry.sites.some((site) => site.kind === 'inherited' && site.line === 127);
    assert.equal(long, entry.arrangement.filler === 30,
      `${entry.id} expands the back-pagination site exactly when its Room is long`);
  }
}

validateContract();

function entryFor(stageId: MessageSwipeStageId): MessageSwipeStage {
  const entry = MESSAGE_SWIPE_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-swipe stage ${stageId}`);
  return entry;
}

export function messageSwipeStage(stageId: MessageSwipeStageId): MessageSwipeStage {
  return entryFor(stageId);
}

export function messageSwipeAssertion(
  stageId: MessageSwipeStageId,
  suffix: string,
): MessageSwipeAssertion {
  const identity: MessageSwipeAssertion = `message-swipe.${stageId}.${suffix}`;
  assert(entryFor(stageId).assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageSwipeRecords(
  stageId: MessageSwipeStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageSwipeReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-swipe'), `Receipt ${name} is not a parity identity`);
}

// Predecessor fields (35–38, 49–101).

export const SWIPE_PREFERENCE_KEY = 'trinity.message-swipe';
export const DRAWER_OPEN_FROM_RIGHT_PX = 44;
/** The product's dead zone, `SWIPE_DEAD_ZONE_PX`, pinned by the guard. */
export const SWIPE_DEAD_ZONE_PX = 56;
export const LONG_ROOM_FILLER = 30;
export const swipeUser = (run: string): string => `swipeact-${run}`;
export const swipeFriend = (run: string): string => `swipefr-${run}`;
export const swipeRoomName = (run: string): string => `Swipe ${run}`;
export const ownBody = (run: string): string => `mine ${run}`;
export const otherBody = (run: string): string => `theirs ${run}`;
export const fillerBody = (index: number): string => `filler ${index}`;
export const otherTransaction = (run: string): string => `o-${run}`;
export const ownTransaction = (run: string): string => `m-${run}`;
export const fillerTransaction = (run: string, index: number): string => `f-${run}-${index}`;

// Field readers.

function object(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} is an object`);
  return value as Record<string, unknown>;
}

function field<T>(value: Record<string, unknown>, name: string, check: (candidate: unknown) => boolean,
  kind: string): T {
  const candidate = value[name];
  assert(check(candidate), `${name} is ${kind}`);
  return candidate as T;
}

const isString = (value: unknown): boolean => typeof value === 'string';
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isFinite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isNullableFinite = (value: unknown): boolean => value === null || isFinite(value);
const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0;

// Native preference.

export interface SwipePreferenceObservation {
  /** Whether the key exists in native Capacitor Preferences. */
  readonly present: boolean;
  /** The raw stored value, when it is a registered direction; otherwise null. */
  readonly value: SwipeSetting | null;
  /** What the product reads: the stored direction, or Off when absent. */
  readonly effective: SwipeSetting | 'invalid';
}

export function assertSeededPreference(
  observation: SwipePreferenceObservation,
  seed: 'right' | 'left' | null,
): void {
  if (seed === null) {
    assert.equal(observation.present, false, 'The unseeded Preferences hold no swipe entry');
    assert.equal(observation.effective, 'off', 'The unseeded direction is the product default, Off');
    return;
  }
  assert.equal(observation.present, true, 'The seeded Preferences hold the swipe entry');
  assert.equal(observation.value, seed, 'The native swipe entry is exactly the seed');
  assert.equal(observation.effective, seed, 'The effective direction is the seed');
}

// The stage view.

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface AffordanceObservation {
  readonly count: number;
  readonly action: string | null;
  readonly end: boolean;
  readonly visible: boolean;
  readonly opacity: number | null;
  readonly color: string | null;
  readonly scale: string | null;
  readonly icon: Box | null;
}

export interface RowObservation {
  readonly body: string;
  /** Rows carrying the body, excluding system lines; the predecessor takes `.last()`. */
  readonly matches: number;
  /** The last match's `data-mid` equals the arranged event id (compared in page). */
  readonly exactEvent: boolean;
  readonly reconciled: boolean;
  readonly visible: boolean;
  readonly box: Box | null;
  readonly drag: string;
  readonly progress: string;
  readonly swiping: boolean;
  readonly armed: boolean;
  readonly affordance: AffordanceObservation;
}

export interface SwipeViewObservation {
  readonly href: string;
  readonly timeOrigin: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly rows: readonly RowObservation[];
  readonly banners: readonly { readonly text: string; readonly strong: string | null }[];
  readonly composer: {
    readonly count: number;
    readonly visible: boolean;
    readonly value: string | null;
    readonly placeholder: string | null;
  };
  readonly encryptionBanners: number;
  readonly drawer: { readonly count: number; readonly visible: boolean; readonly box: Box | null };
  readonly scroll: {
    readonly count: number;
    readonly scrollTop: number | null;
    readonly scrollHeight: number | null;
    readonly clientHeight: number | null;
    readonly box: Box | null;
  };
  readonly settings: {
    readonly hosts: number;
    readonly dialogs: number;
    readonly sectionsVisible: boolean;
    readonly detailNonEmpty: boolean;
    readonly backButtons: number;
  };
}

function parseBox(value: unknown, name: string): Box | null {
  if (value === null) return null;
  const box = object(value, name);
  const read = (key: string): number => field<number>(box, key, isFinite, 'a finite number');
  return {
    left: read('left'), top: read('top'), right: read('right'), bottom: read('bottom'),
    width: read('width'), height: read('height'),
  };
}

function parseAffordance(value: unknown): AffordanceObservation {
  const affordance = object(value, 'Affordance observation');
  return {
    count: field(affordance, 'count', isCount, 'a count'),
    action: field(affordance, 'action', isNullableString, 'a string or null'),
    end: field(affordance, 'end', isBoolean, 'a boolean'),
    visible: field(affordance, 'visible', isBoolean, 'a boolean'),
    opacity: field(affordance, 'opacity', isNullableFinite, 'a finite number or null'),
    color: field(affordance, 'color', isNullableString, 'a string or null'),
    scale: field(affordance, 'scale', isNullableString, 'a string or null'),
    icon: parseBox(affordance['icon'], 'Affordance icon box'),
  };
}

function parseRow(value: unknown, index: number): RowObservation {
  const row = object(value, `Row observation ${index}`);
  return {
    body: field(row, 'body', isString, 'a string'),
    matches: field(row, 'matches', isCount, 'a count'),
    exactEvent: field(row, 'exactEvent', isBoolean, 'a boolean'),
    reconciled: field(row, 'reconciled', isBoolean, 'a boolean'),
    visible: field(row, 'visible', isBoolean, 'a boolean'),
    box: parseBox(row['box'], 'Row box'),
    drag: field(row, 'drag', isString, 'a string'),
    progress: field(row, 'progress', isString, 'a string'),
    swiping: field(row, 'swiping', isBoolean, 'a boolean'),
    armed: field(row, 'armed', isBoolean, 'a boolean'),
    affordance: parseAffordance(row['affordance']),
  };
}

/** Reject incomplete CDP values before any source-mapped assertion is recorded. */
export function parseSwipeView(value: unknown): SwipeViewObservation {
  const view = object(value, 'Swipe view observation');
  const composer = object(view['composer'], 'Composer observation');
  const drawer = object(view['drawer'], 'Drawer observation');
  const scroll = object(view['scroll'], 'Scroll observation');
  const settings = object(view['settings'], 'Settings observation');
  const rows = view['rows'];
  const banners = view['banners'];
  assert(Array.isArray(rows), 'rows is an array');
  assert(Array.isArray(banners), 'banners is an array');
  return {
    href: field(view, 'href', isString, 'a string'),
    timeOrigin: field(view, 'timeOrigin', isFinite, 'a finite number'),
    innerWidth: field(view, 'innerWidth', isFinite, 'a finite number'),
    innerHeight: field(view, 'innerHeight', isFinite, 'a finite number'),
    rows: rows.map(parseRow),
    banners: banners.map((raw, index) => {
      const banner = object(raw, `Banner ${index}`);
      return {
        text: field<string>(banner, 'text', isString, 'a string'),
        strong: field<string | null>(banner, 'strong', isNullableString, 'a string or null'),
      };
    }),
    composer: {
      count: field(composer, 'count', isCount, 'a count'),
      visible: field(composer, 'visible', isBoolean, 'a boolean'),
      value: field(composer, 'value', isNullableString, 'a string or null'),
      placeholder: field(composer, 'placeholder', isNullableString, 'a string or null'),
    },
    encryptionBanners: field(view, 'encryptionBanners', isCount, 'a count'),
    drawer: {
      count: field(drawer, 'count', isCount, 'a count'),
      visible: field(drawer, 'visible', isBoolean, 'a boolean'),
      box: parseBox(drawer['box'], 'Drawer box'),
    },
    scroll: {
      count: field(scroll, 'count', isCount, 'a count'),
      scrollTop: field(scroll, 'scrollTop', isNullableFinite, 'a finite number or null'),
      scrollHeight: field(scroll, 'scrollHeight', isNullableFinite, 'a finite number or null'),
      clientHeight: field(scroll, 'clientHeight', isNullableFinite, 'a finite number or null'),
      box: parseBox(scroll['box'], 'Scroll box'),
    },
    settings: {
      hosts: field(settings, 'hosts', isCount, 'a count'),
      dialogs: field(settings, 'dialogs', isCount, 'a count'),
      sectionsVisible: field(settings, 'sectionsVisible', isBoolean, 'a boolean'),
      detailNonEmpty: field(settings, 'detailNonEmpty', isBoolean, 'a boolean'),
      backButtons: field(settings, 'backButtons', isCount, 'a count'),
    },
  };
}

export function rowFor(view: SwipeViewObservation, body: string): RowObservation {
  const rows = view.rows.filter((row) => row.body === body);
  assert.equal(rows.length, 1, 'The view reports the requested row once');
  return rows[0]!;
}

// Route and Room.

export function roomRouteSegment(roomId: string): string {
  return Buffer.from(roomId).toString('base64url');
}

export interface RoomIdentity {
  readonly name: string;
  readonly roomId: string;
  readonly userId: string;
}

export function assertRoomRoute(href: string, roomId: string, userId: string): void {
  const route = new URL(href);
  assert.equal(route.pathname, `/rooms/${roomRouteSegment(roomId)}`, 'The route is the exact Room');
  assert.equal(route.searchParams.get('account'), userId, 'The route keeps the exact Account');
}

/** Helper line 112: the exact Room's composer is visible after the native open. */
export function assertRoomReady(view: SwipeViewObservation, identity: RoomIdentity): void {
  assert.equal(view.composer.count, 1, 'Exactly one composer is rendered');
  assert(view.composer.visible, 'The composer is visible');
  assert.equal(view.composer.placeholder, `Message #${identity.name}`, 'The composer names the exact Room');
  assertRoomRoute(view.href, identity.roomId, identity.userId);
}

/** Helper line 118: the crypto-state banner has arrived, so the rows no longer reflow. */
export function assertEncryptionBanner(view: SwipeViewObservation): void {
  assert(view.encryptionBanners >= 1, 'The Set up encryption banner is visible');
}

/** Helper line 127: back-pagination has loaded the exact own message row. */
export function assertHistoryLoaded(view: SwipeViewObservation, own: string): void {
  const row = rowFor(view, own);
  assert(row.matches > 0, 'The own message row is loaded');
}

/** Helper 146–150: both target rows are visible, reconciled and the arranged events. */
export function assertTargetRows(view: SwipeViewObservation, bodies: readonly string[]): void {
  for (const body of bodies) {
    const row = rowFor(view, body);
    assert(row.matches >= 1, 'The target row is rendered');
    assert(row.reconciled, 'The target row carries a homeserver event id');
    assert(row.exactEvent, 'The target row is the arranged event');
    assert(row.visible, 'The target row is visible');
  }
}

// Composer outcomes.

/** Line 188: the committed swipe opened the editor for the exact own message. */
export function assertEditing(view: SwipeViewObservation, own: string): void {
  assert.equal(view.banners.length, 1, 'Exactly one composer banner');
  assert(view.banners[0]!.text.includes('Editing'), 'The composer banner says Editing');
  assert.equal(view.composer.value, own, 'The composer holds the exact own message');
}

/** Lines 201, 361, 516: the committed swipe started a reply to the other Account. */
export function assertReplying(view: SwipeViewObservation, friendName: string): void {
  assert.equal(view.banners.length, 1, 'Exactly one composer banner');
  assert(view.banners[0]!.text.includes('Replying to'), 'The composer banner says Replying to');
  assert.equal(view.banners[0]!.strong, friendName, 'The reply names the other Account');
  assert.equal(view.composer.value, '', 'A reply leaves the composer text empty');
}

/** Lines 338, 349, 440, 489, 508: no composer action. */
export function assertNoBanner(view: SwipeViewObservation): void {
  assert.equal(view.banners.length, 0, 'No composer banner');
}

// Affordance.

/** Lines 335, 600, 587: the row renders no swipe affordance at all. */
export function assertNoAffordance(view: SwipeViewObservation, body: string): void {
  assert.equal(rowFor(view, body).affordance.count, 0, 'The row renders no swipe affordance');
}

/** Line 621: the row now renders exactly one affordance. */
export function assertAffordanceLive(view: SwipeViewObservation, body: string): void {
  const row = rowFor(view, body);
  assert(row.exactEvent, 'The row is the arranged event');
  assert.equal(row.affordance.count, 1, 'The row renders exactly one swipe affordance');
}

/** Line 234: the affordance box exists part-way through the drag (Playwright visibility). */
export function assertAffordanceVisible(view: SwipeViewObservation, body: string): void {
  const { affordance } = rowFor(view, body);
  assert.equal(affordance.count, 1, 'Exactly one affordance');
  assert(affordance.visible, 'The affordance has a visible box');
}

/** Lines 238, 242: the affordance names the action it will take. */
export function assertAffordanceAction(view: SwipeViewObservation, body: string,
  action: 'edit' | 'reply'): void {
  const { affordance } = rowFor(view, body);
  assert.equal(affordance.count, 1, 'Exactly one affordance');
  assert.equal(affordance.action, action, `The affordance says ${action}`);
}

/** A held drag: the row is displaced in the swipe direction while the finger is down. */
export function assertHeldDrag(view: SwipeViewObservation, body: string, sign: 1 | -1): number {
  const row = rowFor(view, body);
  const drag = Number.parseFloat(row.drag);
  assert(row.drag.endsWith('px') && Number.isFinite(drag), 'The row carries a live drag distance');
  assert(sign * drag > 0, 'The row is displaced in the swipe direction');
  assert(row.swiping, 'The row is swiping');
  return drag;
}

/** A held, sub-threshold drag: displaced and not yet armed. */
export function assertHeldPartial(view: SwipeViewObservation, body: string, sign: 1 | -1): number {
  const drag = assertHeldDrag(view, body, sign);
  assert(!rowFor(view, body).armed, 'The partial drag is not armed');
  return drag;
}

/** After a release or abandonment the row carries no drag state. */
export function assertRowSettled(view: SwipeViewObservation, body: string): void {
  const row = rowFor(view, body);
  assert.equal(row.drag, '', 'No drag distance remains');
  assert.equal(row.progress, '', 'No drag progress remains');
  assert(!row.swiping && !row.armed, 'No drag class remains');
}

/** Line 309: part-way the affordance has begun to fade in. */
export function assertPartialOpacityPositive(view: SwipeViewObservation, body: string): number {
  const opacity = rowFor(view, body).affordance.opacity;
  assert(opacity !== null && opacity > 0, 'The partial affordance opacity is above zero');
  return opacity;
}

/** Line 311: and it is still short of fully shown. */
export function assertPartialOpacityBelowOne(view: SwipeViewObservation, body: string): number {
  const opacity = rowFor(view, body).affordance.opacity;
  assert(opacity !== null && opacity < 1, 'The partial affordance opacity is below one');
  return opacity;
}

/** Line 314: past the threshold, before release, it is fully shown and armed. */
export function assertArmedOpacityOne(view: SwipeViewObservation, body: string): void {
  const row = rowFor(view, body);
  assert.equal(row.affordance.opacity, 1, 'The armed affordance opacity is exactly one');
  assert(row.armed, 'The row is armed before release');
}

/** Line 317: the icon grew. */
export function assertScaleChanged(partly: AffordanceObservation, armed: AffordanceObservation): void {
  assert(partly.scale !== null && armed.scale !== null, 'Both icon scales are computed');
  assert.notEqual(armed.scale, partly.scale, 'The armed icon scale differs from the partial one');
}

/** Line 318: and recoloured. */
export function assertColourChanged(partly: AffordanceObservation, armed: AffordanceObservation): void {
  assert(partly.color !== null && armed.color !== null, 'Both affordance colours are computed');
  assert.notEqual(armed.color, partly.color, 'The armed colour differs from the partial one');
}

/** Line 411: mid leftward drag, the icon centre lies right of the moved row's end. */
export function assertIconPastRowEnd(view: SwipeViewObservation, body: string): number {
  const row = rowFor(view, body);
  assert(row.box && row.affordance.icon, 'The moved row and its icon are measured');
  const centre = row.affordance.icon.left + row.affordance.icon.width / 2;
  assert(centre > row.box.right, 'The icon centre is past the moved row end');
  return centre;
}

/** Line 412: and inside the row's original extent. */
export function assertIconInsideOriginal(view: SwipeViewObservation, body: string,
  before: Box): number {
  const row = rowFor(view, body);
  assert(row.affordance.icon, 'The icon is measured');
  const centre = row.affordance.icon.left + row.affordance.icon.width / 2;
  assert(centre < before.right, 'The icon centre is inside the original row extent');
  assert(row.affordance.end, 'The affordance sits at the trailing end');
  return centre;
}

/** Line 441: an abandoned drag leaves no `--swipe-drag`. */
export function assertNoDragStyle(view: SwipeViewObservation, body: string): void {
  assert.equal(rowFor(view, body).drag, '', 'The row carries no --swipe-drag');
}

/** Line 488: the timeline's real scroll offset moved. */
export function assertTimelineMoved(view: SwipeViewObservation, before: number): number {
  assert.equal(view.scroll.count >= 1, true, 'The timeline scroller exists');
  const top = view.scroll.scrollTop;
  assert(top !== null && top !== before, 'The timeline scroll offset moved');
  return top;
}

// Drawer.

export function assertDrawerHidden(view: SwipeViewObservation): void {
  assert(!view.drawer.visible, 'The members drawer is hidden');
}

export function assertDrawerVisible(view: SwipeViewObservation): void {
  assert.equal(view.drawer.count, 1, 'Exactly one members drawer');
  assert(view.drawer.visible, 'The members drawer is visible');
}

// Settings (navigation helpers on the Android branch, 19–35 and 64–102).

export function assertAccountRooms(href: string, userId: string): void {
  const url = new URL(href);
  assert(url.pathname.startsWith('/rooms'), 'The route is a Rooms route');
  assert.equal(url.searchParams.get('account'), userId, 'The route is Account-qualified');
}

/** Navigation line 32: the native Settings sections are visible at a Settings route. */
export function assertSettingsSections(view: SwipeViewObservation): void {
  assert(new URL(view.href).pathname.startsWith('/settings'), 'The route is Settings');
  assert(view.settings.sectionsVisible, 'The Settings sections navigation is visible');
}

/** Navigation line 59: the Appearance detail is rendered at its exact route. */
export function assertSettingsDetail(view: SwipeViewObservation, section: string): void {
  assert.equal(new URL(view.href).pathname, `/settings/${section}`, 'The route is the exact section');
  assert(view.settings.detailNonEmpty, 'The Settings detail is not empty');
}

/** Navigation line 69: native Back left the section for Settings or Rooms. */
export function assertSectionUnwound(view: SwipeViewObservation): void {
  const path = new URL(view.href).pathname;
  assert(path === '/settings' || path.startsWith('/rooms'), 'Back left the Settings section');
}

/** Navigation line 99: the host-owned Settings surface has detached. */
export function assertSettingsDetached(view: SwipeViewObservation): void {
  assert.equal(view.settings.hosts, 0, 'No trn-settings remains');
}

/** Line 613: no Settings dialog is shown. */
export function assertSettingsDialogHidden(view: SwipeViewObservation): void {
  assert.equal(view.settings.dialogs, 0, 'No visible Settings dialog');
}

/** Line 614: the route left Settings. */
export function assertNoSettingsPath(view: SwipeViewObservation): void {
  assert.doesNotMatch(new URL(view.href).pathname, /\/settings/u, 'The route is not a Settings route');
}

/** The document never reloaded between the Room opening and the live check. */
export function assertSameDocument(view: SwipeViewObservation, timeOrigin: number): void {
  assert.equal(view.timeOrigin, timeOrigin, 'The same document: no reload');
}

// Native gesture proof.

export interface TrustedPointerEvent {
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  readonly trusted: boolean;
  readonly pointerType: string;
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp: number;
}

export function parsePointerEvents(value: unknown): readonly TrustedPointerEvent[] {
  assert(Array.isArray(value), 'Pointer events are an array');
  return value.map((raw, index) => {
    const event = object(raw, `Pointer event ${index}`);
    const type = field<string>(event, 'type', isString, 'a string');
    assert(['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].includes(type),
      'The event is a pointer event');
    return {
      type: type as TrustedPointerEvent['type'],
      trusted: field(event, 'trusted', isBoolean, 'a boolean'),
      pointerType: field(event, 'pointerType', isString, 'a string'),
      pointerId: field(event, 'pointerId', isFinite, 'a finite number'),
      clientX: field(event, 'clientX', isFinite, 'a finite number'),
      clientY: field(event, 'clientY', isFinite, 'a finite number'),
      timeStamp: field(event, 'timeStamp', isFinite, 'a finite number'),
    };
  });
}

export interface GesturePlan {
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

/**
 * The product's long-press window (`message-row.component.ts`): a press that
 * has not travelled `LONG_PRESS_SLOP_PX` within `LONG_PRESS_MS` opens the
 * message-action sheet. A native gesture must leave that window in time.
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

/**
 * `held`: the pointer is still down and no terminal event arrived.
 * `held-pan`: the pointer is still down, but the platform may have taken it
 * for a pan (`pointercancel`); a release (`pointerup`) is never allowed.
 */
export type GestureEnding = 'up' | 'cancel' | 'up-or-cancel' | 'held' | 'held-pan';

/**
 * The renderer received the device gesture: one trusted touch pointer that
 * went down near the planned start, moved along the plan and left the
 * product's long-press window in time. When the platform takes the stream away
 * (a scroll or a system recogniser) the stream ends in `pointercancel`;
 * otherwise it ends in `pointerup`, unless it is held.
 */
export function assertNativeGesture(
  events: readonly TrustedPointerEvent[],
  plan: GesturePlan,
  ending: GestureEnding,
  tolerance = 3,
): { readonly moves: number; readonly durationMs: number; readonly windowMs: number } {
  assert(events.length > 0 && events.every((event) => event.trusted),
    'Every observed pointer event is trusted device input');
  assert(events.every((event) => event.pointerType === 'touch'), 'Every pointer event is touch');
  const downs = events.filter((event) => event.type === 'pointerdown');
  assert.equal(downs.length, 1, 'Exactly one pointer went down');
  const down = downs[0]!;
  assert(events.every((event) => event.pointerId === down.pointerId), 'One pointer owns the gesture');
  assert.equal(events[0], down, 'The gesture starts with its pointerdown');
  assert(Math.abs(down.clientX - plan.from.x) <= tolerance && Math.abs(down.clientY - plan.from.y) <= tolerance,
    'The pointer went down at the planned device-mapped start');
  const terminal = events.filter((event) => event.type === 'pointerup' || event.type === 'pointercancel');
  if (ending === 'held') {
    assert.equal(terminal.length, 0, 'The held pointer has not been released');
  } else if (ending === 'held-pan') {
    assert(terminal.every((event) => event.type === 'pointercancel'), 'The held pointer has not been released');
    assert(terminal.length <= 1 && (terminal.length === 0 || events.at(-1) === terminal[0]),
      'Only the platform ended the held stream');
  } else {
    assert.equal(terminal.length, 1, 'The pointer ended once');
    assert.equal(events.at(-1), terminal[0], 'The terminal event ends the stream');
    if (ending === 'up') assert.equal(terminal[0]!.type, 'pointerup', 'The pointer was released');
    if (ending === 'cancel') assert.equal(terminal[0]!.type, 'pointercancel', 'The platform took the pointer');
  }
  const moves = events.filter((event) => event.type === 'pointermove');
  if (ending === 'cancel' || ending === 'up-or-cancel') {
    assert(moves.length >= 1, 'The renderer received a path of moves before the gesture ended');
  } else {
    assert(moves.length >= 2, 'The renderer received an interpolated path of moves');
  }
  if (ending === 'up' || ending === 'held') {
    const horizontal = Math.abs(plan.to.x - plan.from.x) >= Math.abs(plan.to.y - plan.from.y);
    const last = moves.at(-1)!;
    const progress = horizontal
      ? (last.clientX - plan.from.x) / (plan.to.x - plan.from.x)
      : (last.clientY - plan.from.y) / (plan.to.y - plan.from.y);
    assert(progress > 0.8, 'The moves travelled along the planned path');
  }
  const left = events.find((event) => event !== down && (event.type !== 'pointermove' ||
    Math.abs(event.clientX - down.clientX) + Math.abs(event.clientY - down.clientY) > LONG_PRESS_SLOP_PX));
  assert(left, 'The gesture left the long-press window');
  const windowMs = left.timeStamp - down.timeStamp;
  assert(windowMs < LONG_PRESS_MS, 'The gesture left the long-press window before the action sheet could open');
  const durationMs = events.at(-1)!.timeStamp - down.timeStamp;
  return { moves: moves.length, durationMs, windowMs };
}

/** D1: the renderer runs the Pixel 5 phone metrics and the installed app reports Android. */
export function assertAppliedProfile(value: unknown): void {
  const applied = object(value, 'Applied profile');
  assert.equal(applied['innerWidth'], 393, 'The renderer is 393 CSS px wide');
  assert.equal(applied['innerHeight'], 727, 'The renderer is 727 CSS px high');
  const dpr = applied['devicePixelRatio'];
  assert(typeof dpr === 'number' && Math.abs(dpr - 2.75) < 0.001, 'The renderer runs at DPR 2.75');
  assert.equal(applied['coarsePointer'], true, 'The renderer has a coarse touch pointer');
  assert.equal(applied['hoverNone'], true, 'The renderer has no hover (touch-only)');
  assert.equal(applied['platform'], 'android', 'The installed app reports Android');
}
