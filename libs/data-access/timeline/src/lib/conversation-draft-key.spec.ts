import { describe, expect, it } from 'vitest';
import { conversationDraftKey } from './conversation-draft-key';

describe('conversationDraftKey', () => {
  it('keys a room draft by Account and Room, as the main composer stores it', () => {
    expect(
      conversationDraftKey({ accountId: '@me:hs', roomId: '!room:hs' }),
    ).toBe('conversation:["@me:hs","!room:hs"]');
  });

  it('keeps two Accounts in one Room apart', () => {
    expect(
      conversationDraftKey({ accountId: '@a:hs', roomId: '!room:hs' }),
    ).not.toBe(
      conversationDraftKey({ accountId: '@b:hs', roomId: '!room:hs' }),
    );
  });
});
