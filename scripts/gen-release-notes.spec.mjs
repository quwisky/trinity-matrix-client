import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  generate,
  parseReleaseBody,
  releaseLine,
  renderReleaseNotes,
  selectReleases,
} from './gen-release-notes.mjs';

describe('gen-release-notes', () => {
  it('parses release-please sections into plain entries', () => {
    const body = [
      '### Features',
      '* **ui:** keep disabled primary and danger buttons readable ([#1435](u)) ([42d3ace](u))',
      '### Bug Fixes',
      '* stop the banner swap ([#1430](u))',
    ].join('\n');
    expect(parseReleaseBody(body)).toEqual({
      added: ['Keep disabled primary and danger buttons readable'],
      fixed: ['Stop the banner swap'],
    });
  });

  it('drops closes links after the commit link', () => {
    const body =
      '### Features\n* **ui:** keep disabled primary and danger buttons readable ([#1435](u)) ([e56129a](u)), closes [#1355](u)';
    expect(parseReleaseBody(body)).toEqual({
      added: ['Keep disabled primary and danger buttons readable'],
    });
  });

  it('maps the configured section names too', () => {
    const body =
      '### Added\n* a ([#1](u))\n### Changed\n* b\n### Reverted\n* c';
    expect(parseReleaseBody(body)).toEqual({
      added: ['A'],
      changed: ['B'],
      reverted: ['C'],
    });
  });

  it('ignores breaking-change and unknown sections and joins wrapped bullets', () => {
    const body = [
      '### ⚠ BREAKING CHANGES',
      '* drop the thing',
      '### Features',
      '* **rooms:** show a long sentence',
      '  that wraps ([#2](u))',
      '### Miscellaneous',
      '* chore',
    ].join('\n');
    expect(parseReleaseBody(body)).toEqual({
      added: ['Show a long sentence that wraps'],
    });
  });

  it('classifies release lines', () => {
    expect(releaseLine('0.5.0')).toBe('stable');
    expect(releaseLine('0.5.0-next.3')).toBe('next');
    expect(releaseLine('0.5.0-dev')).toBeNull();
  });

  it('selects the current line newest first, up to the current version, capped at 20', () => {
    const releases = [
      ...Array.from({ length: 25 }, (_, n) => ({
        version: `0.5.0-next.${n + 1}`,
        date: '2026-01-01',
        body: '### Features\n* x',
      })),
      ...['0.4.0', '0.4.1', '0.4.2'].map((version) => ({
        version,
        date: '2026-01-01',
        body: '### Features\n* y',
      })),
    ];
    const notes = selectReleases(releases, '0.5.0-next.24');
    expect(notes).toHaveLength(20);
    expect(notes.every((n) => n.version.includes('-next'))).toBe(true);
    expect(notes[0].version).toBe('0.5.0-next.24');
  });

  it('writes an empty list without release context', async () => {
    const fetchImpl = vi.fn();
    await expect(generate({}, fetchImpl)).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails a release build when notes cannot be fetched', async () => {
    await expect(
      generate({ TRINITY_RELEASE_NOTES: 'required', GITHUB_TOKEN: 't' }, () =>
        Promise.reject(new Error('offline')),
      ),
    ).rejects.toThrow();
  });

  it('fails a release build when the current version has no notes', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => [
        {
          tag_name: 'v0.0.1',
          published_at: '2026-01-01T00:00:00Z',
          body: '### Features\n* x',
          draft: false,
        },
      ],
    });
    await expect(
      generate(
        { TRINITY_RELEASE_NOTES: 'required', GITHUB_TOKEN: 't' },
        fetchImpl,
      ),
    ).rejects.toThrow(/\d+\.\d+\.\d+/);
  });

  it('uses the supplied body for the current version', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => [] });
    const notes = await generate(
      {
        TRINITY_RELEASE_NOTES: 'required',
        GITHUB_TOKEN: 't',
        TRINITY_CURRENT_RELEASE_NOTES: '### Features\n* new thing',
      },
      fetchImpl,
    );
    expect(notes[0].sections).toEqual({ added: ['New thing'] });
  });

  it('uses the fixture when given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
    try {
      const file = join(dir, 'notes.json');
      const fixture = [{ version: '9.9.9', date: '2026-01-01', sections: {} }];
      writeFileSync(file, JSON.stringify(fixture));
      const fetchImpl = vi.fn();
      await expect(
        generate(
          {
            TRINITY_RELEASE_NOTES: 'required',
            TRINITY_RELEASE_NOTES_FIXTURE: file,
          },
          fetchImpl,
        ),
      ).resolves.toEqual(fixture);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders a typed module', () => {
    const notes = [
      { version: '1.0.0', date: '2026-01-01', sections: { added: ['A'] } },
    ];
    const source = renderReleaseNotes(notes);
    expect(source).toContain(
      'export const RELEASE_NOTES_VALUE: readonly ReleaseNote[] =',
    );
    expect(source).toContain(JSON.stringify(notes, null, 2));
  });
});
