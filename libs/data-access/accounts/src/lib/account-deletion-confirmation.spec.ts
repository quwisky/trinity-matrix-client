import { describe, expect, it } from 'vitest';
import { classifyAccountDeletionIntent } from './account-deletion-confirmation';

describe('classifyAccountDeletionIntent', () => {
  it.each(['DELETE', ' delete ', 'Delete'])('accepts %j', (typed) => {
    expect(classifyAccountDeletionIntent(typed)).toBe('confirmed');
  });

  it.each(['', 'DELET', 'DELETE ME', '@alice:example.org'])(
    'refuses %j',
    (typed) => {
      expect(classifyAccountDeletionIntent(typed)).toBe('mistyped');
    },
  );
});
