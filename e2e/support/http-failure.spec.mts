import { describe, expect, it } from 'vitest';
import { describeFailure, formatFailure, urlPath } from './http-failure.mts';

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
