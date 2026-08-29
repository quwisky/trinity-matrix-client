import { describe, expect, it } from 'vitest';
import {
  AuthenticatedAccountGrant,
  authenticatedAccountGrantPayload,
} from './authenticated-account-grant';

describe('AuthenticatedAccountGrant', () => {
  it('seals credential material behind an opaque, non-serializable grant', () => {
    const grant = AuthenticatedAccountGrant.issue({
      baseUrl: 'https://hs',
      userId: '@new:hs',
      deviceId: 'DEVICE',
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
    });

    expect(Object.keys(grant)).toEqual([]);
    expect(JSON.stringify(grant)).toBe('{}');
    expect(String(grant)).not.toContain('secret-access');
    expect(authenticatedAccountGrantPayload(grant)).toMatchObject({
      userId: '@new:hs',
      accessToken: 'secret-access',
    });
  });
});
