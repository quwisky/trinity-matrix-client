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
    const text = truncateMessage('x '.repeat((MAX_MESSAGE_LENGTH + 500) / 2));

    expect(text.startsWith('x '.repeat(MAX_MESSAGE_LENGTH / 2))).toBe(true);
    expect(text.endsWith('… [500 characters truncated]')).toBe(true);
  });

  it('backs off past characters a local part may hold, such as "\'"', () => {
    const filler = `${'x'.repeat(MAX_MESSAGE_LENGTH - 5)} `;

    expect(truncateMessage(`${filler}@o'neil;x:other.net`)).toBe(
      `${filler}… [19 characters truncated]`,
    );
  });

  it.each([
    ['a long URL', `https://x/?${'a=1&'.repeat(2600)}`],
    ['a run of local-part characters', 'xy;'.repeat(3000)],
  ])('cuts %s with no separator near the limit at the limit', (_name, text) => {
    expect(
      truncateMessage(text).startsWith(text.slice(0, MAX_MESSAGE_LENGTH)),
    ).toBe(true);
  });

  it('cuts before an identifier the limit runs through, never inside it', () => {
    const filler = `${'x'.repeat(MAX_MESSAGE_LENGTH - 7)} `;

    expect(truncateMessage(`${filler}@carol-jones:other.net`)).toBe(
      `${filler}… [22 characters truncated]`,
    );
  });
});
