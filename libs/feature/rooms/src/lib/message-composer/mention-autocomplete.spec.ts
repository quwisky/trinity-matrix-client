import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MentionAutocomplete,
  type MentionMember,
} from './mention-autocomplete';

const member = (name: string, userId = `@${name}:x`): MentionMember => ({
  userId,
  roomDisplayName: name,
  roomAvatarMxc: null,
  roomInitial: name[0],
});

describe('MentionAutocomplete matches', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lowercases the member names once per member list, not per keystroke', () => {
    const members = signal([member('Alice'), member('Bob'), member('Carol')]);
    const mentions = new MentionAutocomplete(members);
    const lower = vi.spyOn(String.prototype, 'toLowerCase');
    mentions.query.set('a');
    mentions.matches();
    const first = lower.mock.calls.length;
    mentions.query.set('al');
    mentions.matches();
    mentions.query.set('ali');
    mentions.matches();
    // Only the query itself is lowercased on later keystrokes.
    expect(lower.mock.calls.length - first).toBe(2);
  });

  it('puts prefix matches first, keeps list order otherwise, and caps at 8', () => {
    const members = signal([
      member('xa'),
      member('ab'),
      member('xxa'),
      ...Array.from({ length: 10 }, (_, i) => member(`a${i}`)),
    ]);
    const mentions = new MentionAutocomplete(members);
    mentions.query.set('A');
    expect(mentions.matches().map((m) => m.roomDisplayName)).toEqual([
      'ab',
      'a0',
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'a6',
    ]);
    mentions.query.set('x');
    expect(mentions.matches().map((m) => m.roomDisplayName)).toEqual([
      'xa',
      'xxa',
      'ab',
      'a0',
      'a1',
      'a2',
      'a3',
      'a4',
    ]);
  });
});

describe('MentionAutocomplete active mentions', () => {
  /** Type `@query` after `text` and accept the member at `index`. */
  const pick = (
    mentions: MentionAutocomplete,
    text: string,
    query: string,
    index = 0,
  ): string => {
    const typed = `${text}@${query}`;
    mentions.sync(typed, typed.length);
    const splice = mentions.accept(typed, typed.length, index);
    if (!splice) throw new Error(`no member matches ${query}`);
    return typed.slice(0, splice.start) + splice.insert;
  };

  it('targets the member picked last when two share a display name', () => {
    const mentions = new MentionAutocomplete(
      signal([member('Alice', '@a1:x'), member('Alice', '@a2:x')]),
    );
    pick(mentions, '', 'Ali', 0); // @a1, then deleted
    const text = pick(mentions, '', 'Ali', 1); // @a2

    expect(mentions.active(text)).toEqual([
      { userId: '@a2:x', display: '@Alice' },
    ]);
  });

  it('does not find a deleted shorter name inside a longer one', () => {
    const mentions = new MentionAutocomplete(
      signal([member('Al', '@al:x'), member('Alice', '@alice:x')]),
    );
    pick(mentions, '', 'Al', 0); // Al, then deleted
    const text = pick(mentions, '', 'Ali'); // Alice

    expect(mentions.active(text)).toEqual([
      { userId: '@alice:x', display: '@Alice' },
    ]);
  });

  it('keeps both a shorter and a longer name that are both in the text', () => {
    const mentions = new MentionAutocomplete(
      signal([member('Al', '@al:x'), member('Alice', '@alice:x')]),
    );
    const text = pick(mentions, pick(mentions, '', 'Ali'), 'Al', 0);

    expect(text).toBe('@Alice @Al ');
    expect(mentions.active(`${text.trimEnd()}, hi`)).toEqual([
      { userId: '@alice:x', display: '@Alice' },
      { userId: '@al:x', display: '@Al' },
    ]);
  });

  it('lists a member picked twice once', () => {
    const mentions = new MentionAutocomplete(
      signal([member('Alice', '@a1:x')]),
    );
    const text = pick(mentions, pick(mentions, '', 'Ali'), 'Ali');

    expect(mentions.active(text)).toEqual([
      { userId: '@a1:x', display: '@Alice' },
    ]);
  });
});
