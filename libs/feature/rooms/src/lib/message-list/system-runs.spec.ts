import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../message-row/message-row.component';
import { groupSystemRuns, summarizeSystemRun } from './system-runs';

function row(id: string, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: id,
    html: null,
    timestamp: 1_000,
    isOwn: false,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'event',
    media: null,
    caption: null,
    captionHtml: null,
    summary: `line ${id}`,
    systemCategory: 'membership',
    showHeader: true,
    daySeparator: null,
    ...over,
  } as MessageRow;
}
const msg = (id: string) =>
  row(id, { kind: 'text', systemCategory: null, summary: null });

describe('summarizeSystemRun', () => {
  it('names one actor and counts by category', () => {
    expect(
      summarizeSystemRun([
        row('1'),
        row('2', { systemCategory: 'room' }),
        row('3', { systemCategory: 'room' }),
      ]),
    ).toBe('Alice · 1 membership change, 2 room changes');
  });

  it('names two actors, then "and N others"', () => {
    expect(
      summarizeSystemRun([row('1'), row('2', { senderName: 'Bob' })]),
    ).toBe('Alice and Bob · 2 membership changes');
    expect(
      summarizeSystemRun([
        row('1'),
        row('2', { senderName: 'Bob' }),
        row('3', { senderName: 'Cy', systemCategory: 'profile' }),
      ]),
    ).toBe('Alice and 2 others · 2 membership changes, 1 profile change');
  });
});

describe('groupSystemRuns', () => {
  it('folds 2+ adjacent system lines into one row keyed by the last event', () => {
    const { rows, runOf } = groupSystemRuns(
      [msg('m1'), row('e1'), row('e2'), row('e3'), msg('m2')],
      null,
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(['m1', 'group:e3', 'm2']);
    expect(rows[1].systemRun?.events.map((e) => e.id)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    expect(rows[1].kind).toBe('event');
    expect(runOf.get('e1')).toBe('group:e3');
    expect(runOf.get('m1')).toBeUndefined();
  });

  it('leaves a single system line alone', () => {
    const input = [msg('m1'), row('e1'), msg('m2')];
    expect(groupSystemRuns(input, null, new Map()).rows).toEqual(input);
  });

  it('splits a run at a day separator and at the first unread event', () => {
    const { rows } = groupSystemRuns(
      [
        row('e1'),
        row('e2'),
        row('e3', { daySeparator: 'Today' }),
        row('e4'),
        row('e5'),
        row('e6'),
      ],
      'e5',
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(['group:e2', 'group:e4', 'group:e6']);
    expect(rows[1].daySeparator).toBe('Today');
  });

  it('keeps the group id when older lines are prepended to the run', () => {
    const before = groupSystemRuns([row('e2'), row('e3')], null, new Map());
    const after = groupSystemRuns(
      [row('e1'), row('e2'), row('e3')],
      null,
      new Map(before.rows.map((r) => [r.id, r])),
    );
    expect(after.rows.map((r) => r.id)).toEqual(['group:e3']);
  });

  it('reuses an unchanged group row object', () => {
    const e1 = row('e1');
    const e2 = row('e2');
    const first = groupSystemRuns([e1, e2, msg('m1')], null, new Map());
    const second = groupSystemRuns(
      [e1, e2, msg('m1'), msg('m2')],
      null,
      new Map(first.rows.map((r) => [r.id, r])),
    );
    expect(second.rows[0]).toBe(first.rows[0]);
  });

  it('groups lines with unusable timestamps like any other', () => {
    const { rows } = groupSystemRuns(
      [row('e1', { timestamp: 0 }), row('e2')],
      null,
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(['group:e2']);
  });
});
