import assert from 'node:assert/strict';

export const MESSAGE_GROUPING_ASSERTIONS = [
  'message-grouping.room-visible',
  'message-grouping.body-first',
  'message-grouping.body-second',
  'message-grouping.body-third',
  'message-grouping.avatar-count',
  'message-grouping.continuation-count',
  'message-grouping.lead-first',
  'message-grouping.lead-second',
  'message-grouping.lead-third',
  'message-grouping.text-left-first',
  'message-grouping.text-left-second',
  'message-grouping.text-left-third',
  'message-grouping.cosy-start-padding',
  'message-grouping.cosy-continuation-padding',
  'message-grouping.cosy-start-margin',
  'message-grouping.phone-no-toolbar',
  'message-grouping.compact-column-gap',
  'message-grouping.compact-total-height',
  'message-grouping.compact-start-padding',
  'message-grouping.compact-start-margin',
  'message-grouping.compact-continuation-padding',
  'message-grouping.compact-body-end-gap',
] as const;

export type MessageGroupingAssertion =
  (typeof MESSAGE_GROUPING_ASSERTIONS)[number];

export interface GroupingEvent {
  readonly id: string;
  readonly body: string;
}

export interface GroupingRow extends GroupingEvent {
  readonly visible: boolean;
  readonly continuation: boolean;
  readonly avatarCount: number;
  readonly leadWidth: number;
  readonly textLeft: number;
  readonly paddingTop: number;
  readonly marginTop: number;
  readonly height: number;
  readonly columnGap: number;
  readonly bodyEndGap: number | null;
}

export interface GroupingGeometry {
  readonly rows: readonly GroupingRow[];
  readonly toolbarCount: number;
}

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

/** Reject incomplete CDP values before any source-mapped assertion is recorded. */
export function parseGroupingGeometry(value: unknown): GroupingGeometry {
  const geometry = object(value, 'Grouping geometry');
  assert(Array.isArray(geometry['rows']) && geometry['rows'].length === 3,
    'Grouping geometry has exactly three rows');
  const rows = geometry['rows'].map((raw: unknown, index: number): GroupingRow => {
    const row = object(raw, `Grouping row ${index}`);
    const avatarCount = numberField(row, 'avatarCount');
    assert(Number.isInteger(avatarCount) && avatarCount >= 0,
      `Grouping row ${index} has a nonnegative avatar count`);
    const rawBodyEndGap = row['bodyEndGap'];
    assert(rawBodyEndGap === null ||
      (typeof rawBodyEndGap === 'number' && Number.isFinite(rawBodyEndGap)),
    `Grouping row ${index} has a finite or absent body gap`);
    return {
      id: stringField(row, 'id'),
      body: stringField(row, 'body'),
      visible: booleanField(row, 'visible'),
      continuation: booleanField(row, 'continuation'),
      avatarCount,
      leadWidth: numberField(row, 'leadWidth'),
      textLeft: numberField(row, 'textLeft'),
      paddingTop: numberField(row, 'paddingTop'),
      marginTop: numberField(row, 'marginTop'),
      height: numberField(row, 'height'),
      columnGap: numberField(row, 'columnGap'),
      bodyEndGap: rawBodyEndGap,
    };
  });
  const toolbarCount = numberField(geometry, 'toolbarCount');
  assert(Number.isInteger(toolbarCount) && toolbarCount >= 0,
    'Grouping toolbar count is nonnegative');
  return { rows, toolbarCount };
}

export function assertGroupingRecords(actual: readonly string[]): void {
  assert.equal(actual.length, 22, 'Exactly 22 Android grouping records');
  assert.equal(new Set(actual).size, 22, 'Every grouping record is unique');
  assert.deepEqual(actual, MESSAGE_GROUPING_ASSERTIONS,
    'Grouping records retain source order');
}

export function assertGroupingRoomRoute(
  url: string,
  roomId: string,
  userId: string,
): void {
  const route = new URL(url);
  assert.equal(route.pathname,
    `/rooms/${Buffer.from(roomId).toString('base64url')}`,
    'Native navigation reached the exact Room');
  assert.equal(route.searchParams.get('account'), userId,
    'Native navigation retained the exact Account');
  assert.equal(route.searchParams.get('view'), 'rooms',
    'Native navigation retained the Rooms view');
}

export function assertExactRows(
  rows: readonly GroupingRow[],
  expected: readonly GroupingEvent[],
): void {
  assert.equal(expected.length, 3, 'Fixture has exactly three grouped events');
  assert.equal(rows.length, 3, 'Renderer has exactly three scoped rows');
  assert(expected.every((event) => event.id.startsWith('$')),
    'Fixture events have reconciled Matrix IDs');
  assert.equal(new Set(expected.map((event) => event.id)).size, 3,
    'Fixture events have distinct IDs');
  assert.deepEqual(rows.map((row) => row.id), expected.map((event) => event.id),
    'Rendered rows retain exact event IDs and DOM order');
  assert.deepEqual(rows.map((row) => row.body), expected.map((event) => event.body),
    'Rendered rows retain exact message bodies');
  assert(rows.every((row) => row.visible), 'Every exact row is visible');
}

function assertGroupingStructure(rows: readonly GroupingRow[]): void {
  assert.equal(rows.length, 3, 'Grouping has three rows');
  assert.deepEqual(rows.map((row) => row.avatarCount), [1, 0, 0],
    'Only the group-start row has an avatar');
  assert.deepEqual(rows.map((row) => row.continuation), [false, true, true],
    'The second and third rows are continuations');
  for (const row of rows) {
    assert.equal(row.leadWidth, 40,
      'Used avatar or gutter lead is exactly 40 CSS pixels');
    assert(Math.abs(row.textLeft - rows[0]!.textLeft) <= 1,
      'Text left edges align within one CSS pixel');
  }
}

export function assertCosyGrouping(geometry: GroupingGeometry): void {
  const { rows } = geometry;
  assertGroupingStructure(rows);
  assert(rows[0]!.paddingTop >= 16,
    'Cosy group gap is start padding inside the border box');
  assert.equal(rows[1]!.paddingTop, 0,
    'First cosy continuation has no top padding');
  assert.equal(rows[2]!.paddingTop, 0,
    'Second cosy continuation has no top padding');
  assert.equal(rows[0]!.marginTop, 0,
    'Cosy group gap is not a start margin');
  assert.equal(geometry.toolbarCount, 0,
    'Installed phone has no desktop hover toolbar');
}

export function assertCompactGrouping(
  cosy: GroupingGeometry,
  compact: GroupingGeometry,
): void {
  assertGroupingStructure(compact.rows);
  assert(compact.rows.every((row) => row.columnGap === 8),
    'Every Compact row has an exact 8 CSS pixel column gap');
  const total = (geometry: GroupingGeometry) =>
    geometry.rows.reduce((sum, row) => sum + row.height, 0);
  assert(total(compact) < total(cosy),
    'Compact total border-box height is lower than cosy');
  assert.equal(compact.rows[0]!.paddingTop, 12,
    'Compact group-start padding is exactly 12 CSS pixels');
  assert.equal(compact.rows[0]!.marginTop, 0,
    'Compact group-start gap is not a margin');
  assert.equal(compact.rows[1]!.paddingTop, 0,
    'First Compact continuation has no top padding');
  assert.equal(compact.rows[2]!.paddingTop, 0,
    'Second Compact continuation has no top padding');
  const bodyEndGap = compact.rows[1]!.bodyEndGap;
  assert(bodyEndGap !== null && Number.isFinite(bodyEndGap),
    'Compact continuation has a measured trailing body gap');
  assert(Math.abs(bodyEndGap) <= 1,
    'Compact trailing body gap is within one CSS pixel of zero');
}
