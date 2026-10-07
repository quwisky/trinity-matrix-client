import { accountInitial } from './account-initial';

describe('accountInitial', () => {
  it('uses the first visible character of the display name', () => {
    expect(accountInitial({ userId: '@alice:hs', displayName: '@bob' })).toBe(
      'B',
    );
  });

  it('falls back to the mxid local part when the display name has nothing visible', () => {
    expect(accountInitial({ userId: '@alice:hs', displayName: '' })).toBe('A');
    expect(accountInitial({ userId: '@alice:hs', displayName: '@!# ' })).toBe(
      'A',
    );
  });
});
