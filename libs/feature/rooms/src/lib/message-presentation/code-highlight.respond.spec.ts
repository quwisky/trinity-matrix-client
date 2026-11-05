import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeLanguage } from './code-languages';
import type {
  HighlightReply,
  HighlightRequest,
  HighlightStarted,
} from './code-highlight.client';
import { respond as respondTo } from './code-highlight.respond';

// Counts grammar loads per id and lets a test fail one load.
const grammars = vi.hoisted(() => ({
  calls: new Map<string, number>(),
  failOnce: new Set<string>(),
}));
vi.mock('./code-languages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./code-languages')>();
  const wrap = (entry: CodeLanguage | null): CodeLanguage | null =>
    entry && {
      id: entry.id,
      load: async () => {
        grammars.calls.set(entry.id, (grammars.calls.get(entry.id) ?? 0) + 1);
        if (grammars.failOnce.delete(entry.id)) throw new Error('404');
        return entry.load();
      },
    };
  return {
    ...actual,
    languageById: (id: string) => wrap(actual.languageById(id)),
  };
});

/** Run one request; returns its reply and every message the worker posted, in order. */
async function respond(
  request: HighlightRequest,
  onStart?: (seq: number) => void,
  log: (HighlightReply | HighlightStarted)[] = [],
): Promise<HighlightReply> {
  await respondTo(request, (message) => {
    log.push(message);
    if ('started' in message) onStart?.(message.seq);
  });
  const reply = log.find(
    (message): message is HighlightReply =>
      message.seq === request.seq && 'result' in message,
  );
  if (!reply) throw new Error(`no reply for ${request.seq}`);
  return reply;
}

const text = (lines: readonly (readonly (readonly [string, unknown])[])[]) =>
  lines.map((line) => line.map(([t]) => t).join('')).join('\n');

describe('respond (the highlight worker)', () => {
  beforeEach(() => {
    grammars.calls.clear();
    grammars.failOnce.clear();
  });

  it('highlights by highlight.js id, not fence name', async () => {
    const reply = await respond({ seq: 1, id: 'shell', code: '$ echo hi\nhi' });

    expect(reply.seq).toBe(1);
    expect(reply.result.kind).toBe('lines');
    if (reply.result.kind === 'lines')
      expect(text(reply.result.lines)).toBe('$ echo hi\nhi');
  });

  it('answers plain for an unknown id or code over the caps', async () => {
    expect(
      (await respond({ seq: 2, id: 'toml', code: 'a = 1' })).result,
    ).toEqual({ kind: 'plain' });
    expect(
      (await respond({ seq: 3, id: 'python', code: 'x'.repeat(4_097) })).result,
    ).toEqual({ kind: 'plain' });
  });

  it('registers a grammar once when two requests wait on its first load', async () => {
    const [a, b] = await Promise.all([
      respond({ seq: 4, id: 'lua', code: 'local a = 1' }),
      respond({ seq: 5, id: 'lua', code: 'local b = 2' }),
    ]);

    expect(a.result.kind).toBe('lines');
    expect(b.result.kind).toBe('lines');
  });

  it('asks for a retry when a grammar fails to load, and loads it on the next request', async () => {
    grammars.failOnce.add('go');

    expect(
      (await respond({ seq: 6, id: 'go', code: 'func a() {}' })).result,
    ).toEqual({ kind: 'retry' });
    expect(
      (await respond({ seq: 7, id: 'go', code: 'func a() {}' })).result.kind,
    ).toBe('lines');
    expect(grammars.calls.get('go')).toBe(2);
  });

  it('reports the start of tokenizing only for blocks it highlights', async () => {
    const started: number[] = [];
    const onStart = (seq: number) => started.push(seq);

    await respond({ seq: 8, id: 'python', code: 'x = 1' }, onStart);
    await respond({ seq: 9, id: 'toml', code: 'a = 1' }, onStart);
    await respond({ seq: 10, id: 'python', code: 'x'.repeat(4_097) }, onStart);

    expect(started).toEqual([8]);
  });

  it('replies to each block straight after tokenizing it, even when blocks share a first load', async () => {
    const log: (HighlightReply | HighlightStarted)[] = [];
    await Promise.all([
      respond({ seq: 11, id: 'kotlin', code: 'val a = 1' }, undefined, log),
      respond({ seq: 12, id: 'kotlin', code: 'val b = 2' }, undefined, log),
    ]);

    expect(
      log.map((m) => `${'started' in m ? 'start' : 'reply'}:${m.seq}`),
    ).toEqual(['start:11', 'reply:11', 'start:12', 'reply:12']);
  });
});
