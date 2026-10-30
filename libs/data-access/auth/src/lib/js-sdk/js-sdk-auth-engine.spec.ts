import { Injector } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: vi.fn() };
});

import {
  ConnectionError,
  HTTPError,
  MatrixError,
  createClient,
} from 'matrix-js-sdk';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { NOT_SIGNED_IN } from '@trinity/util/matrix';
import { AUTH_METADATA } from '../auth-metadata.fixture';
import { JsSdkAuthEngine } from './js-sdk-auth-engine';

const BASE = 'https://hs';

describe('JsSdkAuthEngine', () => {
  const client = {
    loginRequest: vi.fn(),
    setPassword: vi.fn(),
    isUsernameAvailable: vi.fn(),
    getAuthMetadata: vi.fn(),
    whoami: vi.fn(),
    registerRequest: vi.fn(),
    requestRegisterEmailToken: vi.fn(),
  };
  const live = { setPassword: vi.fn() };
  let engine: JsSdkAuthEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createClient).mockReturnValue(client as never);
    engine = Injector.create({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === '@me:hs' ? live : null),
          },
        },
        JsSdkAuthEngine,
      ],
    }).get(JsSdkAuthEngine);
  });

  const password = (deviceId: string | null = null) =>
    firstValueFrom(
      engine.loginWithPassword(BASE, {
        localpart: 'me',
        password: 'pw',
        deviceDisplayName: 'Trinity',
        deviceId,
      }),
    );
  const token = () =>
    firstValueFrom(
      engine.loginWithToken(BASE, {
        token: 't',
        deviceDisplayName: 'Trinity',
        deviceId: null,
      }),
    );

  it('returns the session a password login produced', async () => {
    client.loginRequest.mockResolvedValue({
      user_id: '@me:hs',
      device_id: 'D',
      access_token: 'tok',
      well_known: {},
    });

    await expect(password('D')).resolves.toEqual({
      ok: true,
      value: {
        userId: '@me:hs',
        deviceId: 'D',
        accessToken: 'tok',
        refreshToken: null,
      },
    });
    expect(client.loginRequest).toHaveBeenCalledWith({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'me' },
      password: 'pw',
      initial_device_display_name: 'Trinity',
      device_id: 'D',
    });
  });

  it.each([
    ['M_FORBIDDEN', new MatrixError({ errcode: 'M_FORBIDDEN' }, 403)],
    ['a bare 401', new HTTPError('Unauthorized', 401)],
    ['a bare 403', new HTTPError('Forbidden', 403)],
  ])('refuses the credentials of a password login on %s', async (_, error) => {
    client.loginRequest.mockRejectedValue(error);

    await expect(password()).resolves.toMatchObject({
      ok: false,
      failure: {
        code: 'login-refused',
        params: { reason: 'invalid-credentials' },
      },
    });
  });

  it('refuses a deactivated account on either login', async () => {
    client.loginRequest.mockRejectedValue(
      new MatrixError({ errcode: 'M_USER_DEACTIVATED' }, 403),
    );
    const deactivated = {
      ok: false,
      failure: { code: 'login-refused', params: { reason: 'deactivated' } },
    };

    await expect(password()).resolves.toMatchObject(deactivated);
    await expect(token()).resolves.toMatchObject(deactivated);
  });

  it('refuses an expired or spent login token as an invalid token', async () => {
    client.loginRequest.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    );

    await expect(token()).resolves.toMatchObject({
      ok: false,
      failure: {
        code: 'login-refused',
        diagnostic: { httpStatus: 403, errcode: 'M_FORBIDDEN' },
        params: { reason: 'invalid-token' },
      },
    });
  });

  it('fails a login that cannot reach the server without refusing it', async () => {
    client.loginRequest.mockRejectedValue(new ConnectionError('fetch failed'));

    await expect(password()).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'network', code: 'request-failed' },
    });
  });

  it('passes the metadata through as served, the RFC 9207 iss flag included', async () => {
    const served = {
      ...AUTH_METADATA,
      authorization_response_iss_parameter_supported: true,
    };
    client.getAuthMetadata.mockResolvedValue(served);

    await expect(firstValueFrom(engine.authMetadata(BASE))).resolves.toEqual({
      ok: true,
      value: served,
    });
  });

  it('asks whoami with the token, a session without a device naming none', async () => {
    client.whoami.mockResolvedValue({ user_id: '@me:hs' });

    await expect(firstValueFrom(engine.whoami(BASE, 'tok'))).resolves.toEqual({
      ok: true,
      value: { userId: '@me:hs', deviceId: null },
    });
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: BASE,
      accessToken: 'tok',
    });
  });

  it('fails forbidden when the server does not register accounts', async () => {
    client.isUsernameAvailable.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    );

    await expect(
      firstValueFrom(engine.usernameAvailable(BASE, 'probe')),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'forbidden' } });
  });

  describe('resetting a password', () => {
    const reset = () =>
      firstValueFrom(
        engine.resetPassword(BASE, {
          sid: 'sid-1',
          clientSecret: 'secret-1',
          newPassword: 'new-pass',
          logoutDevices: true,
        }),
      );

    it('sends the email credentials under both keys', async () => {
      client.setPassword.mockResolvedValue({});
      const creds = { sid: 'sid-1', client_secret: 'secret-1' };

      await expect(reset()).resolves.toEqual({ ok: true, value: null });
      expect(createClient).toHaveBeenCalledWith({ baseUrl: BASE });
      expect(client.setPassword).toHaveBeenCalledWith(
        {
          type: 'm.login.email.identity',
          threepid_creds: creds,
          threepidCreds: creds,
        },
        'new-pass',
        true,
      );
    });

    it('answers a link not confirmed yet with its challenge', async () => {
      client.setPassword.mockRejectedValue(
        new MatrixError(
          { flows: [{ stages: ['m.login.email.identity'] }], session: 's' },
          401,
        ),
      );

      await expect(reset()).resolves.toMatchObject({
        ok: false,
        failure: {
          code: 'uia-required',
          params: {
            challenge: {
              session: 's',
              flows: [{ stages: ['m.login.email.identity'] }],
            },
          },
        },
      });
    });

    it('carries the reason of a weak password as server text', async () => {
      client.setPassword.mockRejectedValue(
        new MatrixError(
          { errcode: 'M_WEAK_PASSWORD', error: 'Too short' },
          400,
        ),
      );

      await expect(reset()).resolves.toMatchObject({
        ok: false,
        failure: {
          code: 'request-failed',
          diagnostic: { errcode: 'M_WEAK_PASSWORD' },
          params: { serverMessage: 'Too short' },
        },
      });
    });

    it('carries no server text for any other refusal', async () => {
      client.setPassword.mockRejectedValue(
        new MatrixError(
          { errcode: 'M_UNKNOWN', error: 'internal detail' },
          400,
        ),
      );

      const result = await reset();

      expect(result.ok || result.failure).not.toHaveProperty('params');
    });
  });

  describe('registering', () => {
    const REGISTRATION = {
      localpart: 'new',
      password: 'pw',
      deviceDisplayName: 'Trinity',
    };
    const register = (auth: { session: string; type?: string } | null = null) =>
      firstValueFrom(engine.register(BASE, REGISTRATION, auth));

    it('asks for a refresh token and a login, with no auth on the probe', async () => {
      client.registerRequest.mockResolvedValue({
        user_id: '@new:hs',
        device_id: 'D',
        access_token: 'tok',
        refresh_token: 'ref',
        expires_in_ms: 1000,
      });

      await expect(register()).resolves.toEqual({
        ok: true,
        value: {
          userId: '@new:hs',
          deviceId: 'D',
          accessToken: 'tok',
          refreshToken: 'ref',
          expiresInMs: 1000,
        },
      });
      expect(client.registerRequest).toHaveBeenCalledWith({
        username: 'new',
        password: 'pw',
        refresh_token: true,
        inhibit_login: false,
        initial_device_display_name: 'Trinity',
      });
    });

    it('sends the stage auth and passes a missing token through as null', async () => {
      client.registerRequest.mockResolvedValue({ user_id: '@new:hs' });

      await expect(
        register({ type: 'm.login.dummy', session: 's' }),
      ).resolves.toEqual({
        ok: true,
        value: {
          userId: '@new:hs',
          deviceId: null,
          accessToken: null,
          refreshToken: null,
          expiresInMs: null,
        },
      });
      expect(client.registerRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { type: 'm.login.dummy', session: 's' },
        }),
      );
    });

    it("answers a 401 with its challenge, the stage params and the server's text", async () => {
      const params = { 'm.login.terms': { policies: {} } };
      client.registerRequest.mockRejectedValue(
        new MatrixError(
          {
            session: 's',
            flows: [{ stages: ['m.login.terms'] }],
            completed: [],
            params,
            errcode: 'M_UNAUTHORIZED',
            error: 'Terms not accepted',
          },
          401,
        ),
      );

      await expect(register()).resolves.toEqual({
        ok: false,
        failure: expect.objectContaining({
          code: 'uia-required',
          params: {
            challenge: {
              session: 's',
              flows: [{ stages: ['m.login.terms'] }],
              completed: [],
              params,
            },
            serverMessage: 'Terms not accepted',
          },
        }),
      });
    });

    it('answers a 401 without flows as a challenge with none', async () => {
      client.registerRequest.mockRejectedValue(
        new MatrixError({ errcode: 'M_UNAUTHORIZED' }, 401),
      );

      await expect(register()).resolves.toMatchObject({
        ok: false,
        failure: {
          code: 'uia-required',
          params: { challenge: { flows: [], completed: [] } },
        },
      });
    });

    it("carries the server's text on a refusal that is not a challenge", async () => {
      client.registerRequest.mockRejectedValue(
        new MatrixError(
          {
            errcode: 'M_USER_IN_USE',
            error: 'User ID already taken.',
            flows: [{ stages: ['m.login.dummy'] }],
          },
          400,
        ),
      );

      await expect(register()).resolves.toEqual({
        ok: false,
        failure: {
          kind: 'http',
          code: 'request-failed',
          diagnostic: expect.objectContaining({ errcode: 'M_USER_IN_USE' }),
          params: { serverMessage: 'User ID already taken.' },
        },
      });
    });

    it('fails without server text when the server cannot be reached', async () => {
      client.registerRequest.mockRejectedValue(
        new ConnectionError('fetch failed'),
      );

      const result = await register();

      expect(result.ok || result.failure).toMatchObject({ kind: 'network' });
      expect(result.ok || result.failure).not.toHaveProperty('params');
    });

    it("requests the email token, carrying a refused address's text", async () => {
      client.requestRegisterEmailToken
        .mockResolvedValueOnce({ sid: 'sid-1' })
        .mockRejectedValueOnce(
          new MatrixError(
            { errcode: 'M_THREEPID_IN_USE', error: 'Email is already in use' },
            400,
          ),
        );
      const request = () =>
        firstValueFrom(
          engine.requestRegistrationEmailToken(BASE, {
            email: 'a@b.c',
            clientSecret: 'secret',
            sendAttempt: 2,
          }),
        );

      await expect(request()).resolves.toEqual({
        ok: true,
        value: { sid: 'sid-1' },
      });
      expect(client.requestRegisterEmailToken).toHaveBeenCalledWith(
        'a@b.c',
        'secret',
        2,
      );
      await expect(request()).resolves.toMatchObject({
        ok: false,
        failure: { params: { serverMessage: 'Email is already in use' } },
      });
    });
  });

  describe('changing a password', () => {
    it('probes the live client without any auth, keeping other sessions', async () => {
      live.setPassword.mockResolvedValue({});

      await expect(
        firstValueFrom(engine.changePassword('@me:hs', 'new-pw', null)),
      ).resolves.toEqual({ ok: true, value: null });
      expect(live.setPassword).toHaveBeenCalledWith(undefined, 'new-pw', false);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('fails not-signed-in for an account with no live client', async () => {
      await expect(
        firstValueFrom(engine.changePassword('@other:hs', 'new-pw', null)),
      ).resolves.toEqual({ ok: false, failure: NOT_SIGNED_IN });
    });
  });
});
