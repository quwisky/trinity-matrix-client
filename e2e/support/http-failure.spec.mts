import { describe, expect, it } from 'vitest';
import {
  describeAppiumFailure,
  describeFailure,
  formatFailure,
  urlPath,
} from './http-failure.mts';

const LEAKY_BODY = JSON.stringify({
  errcode: 'M_FORBIDDEN',
  error: 'User @alice:localhost not in room !secret:localhost',
  access_token: 'syt_leaked_token',
});

describe('describeFailure', () => {
  it('keeps the status and errcode of a fetch Response and drops the body', async () => {
    const message = await describeFailure(
      'join room',
      new Response(LEAKY_BODY, { status: 403 }),
    );

    expect(message).toBe('join room: HTTP 403 M_FORBIDDEN');
    expect(message).not.toContain('alice');
    expect(message).not.toContain('!secret');
    expect(message).not.toContain('syt_leaked_token');
  });

  it('reads the status of a Playwright APIResponse', async () => {
    const message = await describeFailure('login', {
      status: () => 401,
      text: async () => '{"errcode":"M_UNKNOWN_TOKEN","error":"Token syt_x"}',
    });

    expect(message).toBe('login: HTTP 401 M_UNKNOWN_TOKEN');
  });

  it('gives the status alone when the body is not JSON', async () => {
    const message = await describeFailure(
      'createRoom',
      new Response('<html>proxy error for @bob:localhost</html>', {
        status: 502,
      }),
    );

    expect(message).toBe('createRoom: HTTP 502');
  });

  it('gives the status alone when the body cannot be read', async () => {
    const message = await describeFailure('sync', {
      status: 500,
      text: () => Promise.reject(new Error('socket hang up')),
    });

    expect(message).toBe('sync: HTTP 500');
  });
});

describe('formatFailure', () => {
  it('ignores an errcode that is not a Matrix error code', () => {
    expect(
      formatFailure(
        'register',
        400,
        JSON.stringify({ errcode: 'token syt_leaked_token' }),
      ),
    ).toBe('register: HTTP 400');
    expect(
      formatFailure('register', 400, '{"errcode":"syt_leaked_token"}'),
    ).toBe('register: HTTP 400');
    expect(
      formatFailure(
        'register',
        400,
        JSON.stringify({ errcode: `M_${'A'.repeat(64)}` }),
      ),
    ).toBe('register: HTTP 400');
    expect(formatFailure('register', 400, '{"errcode":42}')).toBe(
      'register: HTTP 400',
    );
    expect(formatFailure('register', 400, '["M_FORBIDDEN"]')).toBe(
      'register: HTTP 400',
    );
  });

  it('keeps a namespaced errcode', () => {
    expect(
      formatFailure(
        'upload',
        413,
        '{"errcode":"IO.ELEMENT.M_TOO_LARGE","error":"x"}',
      ),
    ).toBe('upload: HTTP 413 IO.ELEMENT.M_TOO_LARGE');
  });
});

describe('describeAppiumFailure', () => {
  it('keeps the W3C error code and points at appium.log, never the message', async () => {
    const message = await describeAppiumFailure(
      'Network.enable',
      new Response(
        JSON.stringify({
          value: {
            error: 'unknown error',
            message: 'cannot reach https://localhost/?access_token=syt_x',
            stacktrace: 'at @alice:localhost',
          },
        }),
        { status: 500 },
      ),
    );

    expect(message).toBe(
      'Network.enable: HTTP 500 unknown error (details in appium.log)',
    );
  });

  it('leaves out an error code that is not a W3C error name', async () => {
    const message = await describeAppiumFailure(
      'Network.enable',
      new Response(
        JSON.stringify({ value: { error: 'token syt_leaked_token' } }),
        { status: 500 },
      ),
    );

    expect(message).toBe('Network.enable: HTTP 500 (details in appium.log)');
  });

  it('gives the status alone when the body is not a WebDriver error', async () => {
    const message = await describeAppiumFailure(
      'Network.enable',
      new Response('Bad gateway for @bob:localhost', { status: 502 }),
    );

    expect(message).toBe('Network.enable: HTTP 502 (details in appium.log)');
  });
});

describe('urlPath', () => {
  it('drops the query string and fragment', () => {
    expect(
      urlPath(
        'https://localhost:8448/_matrix/client/v3/sync?access_token=syt_x#frag',
      ),
    ).toBe('/_matrix/client/v3/sync');
  });

  it('drops the query string of a relative URL', () => {
    expect(urlPath('/_synapse/admin/v1/register?token=syt_x')).toBe(
      '/_synapse/admin/v1/register',
    );
  });
});
