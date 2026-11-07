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
