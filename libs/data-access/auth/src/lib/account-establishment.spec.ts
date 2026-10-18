import { describe, expect, it } from 'vitest';
import {
  UnacceptableAccountError,
  accountEstablishment,
  type AuthenticatedSessionResponse,
} from './account-establishment';

function establish(user_id: string, device_id: string) {
  const response: AuthenticatedSessionResponse = {
    user_id,
    device_id,
    access_token: 'tok',
  };
  return accountEstablishment('https://hs.example', response, 'add', 'upsert');
}

describe('accountEstablishment', () => {
  it.each([
    ['@x:localhost', 'DEV'],
    ['@alice:matrix.org', 'ABCDEFGHIJ'],
    ['@alice:example.org:8448', 'DEV'],
    ['@a:1.2.3.4', 'DEV'],
    ['@a:[::1]:8448', 'DEV'],
    ['@Alice=_.-/+!~:example.org', 'dev with space'],
  ])('accepts %s with device %s', (userId, deviceId) => {
    expect(() => establish(userId, deviceId)).not.toThrow();
  });

  it.each([
    // Together these spell another account's crypto-store prefix.
    ['@alice', 'example.org:ABCDEFGHIJ'],
    ['alice:example.org', 'DEV'],
    ['@:example.org', 'DEV'],
    ['@alice:', 'DEV'],
    ['@alice:exa mple.org', 'DEV'],
    ['@alice:example.org/path', 'DEV'],
    ['@alice:example.org:99999', 'DEV'],
    ['@ali\nce:example.org', 'DEV'],
    ['@ali ce:example.org', 'DEV'],
    ['@ali\u200bce:example.org', 'DEV'],
    ['@ali\u202ece:example.org', 'DEV'],
    ['@alicé:example.org', 'DEV'],
    ['@alice:example.org:', 'DEV'],
    ['@alice:example.org:08448', 'DEV'],
    [`@${'a'.repeat(250)}:example.org`, 'DEV'],
    ['@alice:example.org', ''],
    ['@alice:example.org', 'DE:V'],
    ['@alice:example.org', 'DE\u0000V'],
    ['@alice:example.org', 'DE\u007fV'],
    ['@alice:example.org', 'D'.repeat(256)],
  ])('refuses %j with device %j before issuing a grant', (userId, deviceId) => {
    expect(() => establish(userId, deviceId)).toThrow(UnacceptableAccountError);
  });
});
