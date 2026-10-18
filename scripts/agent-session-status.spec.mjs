import { describe, expect, it } from 'vitest';
import { status } from './agent-session-status.mjs';

const facts = (overrides = {}) => ({
  read: (args) =>
    args.join(' ') === 'config user.email' ? 'a@example.org' : '',
  behind: 0,
  staleLock: false,
  ...overrides,
});

describe('agent-session-status SessionStart hook', () => {
  it('says nothing when the checkout is ready to work in', () => {
    expect(status(facts())).toEqual([]);
  });

  it('names a stale main, a missing email and a lock left by an ended run', () => {
    const notes = status(
      facts({ behind: 69, read: () => '', staleLock: true }),
    );

    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/69 commit\(s\) behind origin\/main/);
    expect(notes[1]).toMatch(/user\.email/);
    expect(notes[2]).toMatch(/homeserver\.lock .* EEXIST/);
  });
});
