import { describe, expect, it } from 'vitest';
import { MANAGE_IDENTITY, isTrustDialogResult } from './trust-dialog-result';

describe('isTrustDialogResult', () => {
  it('recognises the manage-identity result', () => {
    expect(isTrustDialogResult(MANAGE_IDENTITY)).toBe(true);
  });

  it.each([
    undefined,
    null,
    'manage-identity',
    {},
    { kind: 'settings', section: 'security' },
  ])('rejects %j', (value) => {
    expect(isTrustDialogResult(value)).toBe(false);
  });
});
