import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_LENGTH } from '../diagnostic-entry.model';
import { formatLogArgs, truncateMessage } from './format-log-args';

describe('formatLogArgs', () => {
  it('joins strings, numbers and objects the way the console shows them', () => {
    expect(
      formatLogArgs([
        '[trinity] Matrix request failed',
        { code: 'M_LIMIT' },
        3,
      ]),
    ).toBe('[trinity] Matrix request failed {"code":"M_LIMIT"} 3');
  });

  it('writes an error with its stack', () => {
    const error = new Error('boom');

    expect(formatLogArgs([error])).toBe(error.stack);
  });

  it('never stores key bytes passed as typed arrays or buffers', () => {
    const key = new Uint8Array(32).fill(7);

    expect(formatLogArgs(['key', key, key.buffer, { nested: key }])).toBe(
      'key [binary 32 bytes] [binary 32 bytes] {"nested":"[binary 32 bytes]"}',
    );
  });

  it('survives circular objects', () => {
    const node: Record<string, unknown> = { name: 'node' };
    node['self'] = node;

    expect(formatLogArgs([node])).toBe('{"name":"node","self":"[circular]"}');
  });

  it('replaces a value it cannot format with <redacted>', () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no reading');
        },
        ownKeys: () => {
          throw new Error('no listing');
        },
      },
    );

    expect(formatLogArgs(['before', hostile, 'after'])).toBe(
      'before <redacted> after',
    );
  });

  it('leaves length to the caller, which scrubs first', () => {
    const long = 'x'.repeat(MAX_MESSAGE_LENGTH + 500);

    expect(formatLogArgs([long])).toBe(long);
  });
});

describe('truncateMessage', () => {
  it('cuts a huge message and says how much was cut', () => {
    const text = truncateMessage('x'.repeat(MAX_MESSAGE_LENGTH + 500));

    expect(text.startsWith('x'.repeat(MAX_MESSAGE_LENGTH))).toBe(true);
    expect(text.endsWith('… [500 characters truncated]')).toBe(true);
  });
});
