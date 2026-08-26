import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const indexHtml = readFileSync(
  join(workspaceRoot, 'apps/trinity/src/index.html'),
  'utf8',
);
const frameTemplate =
  'libs/feature/rooms/src/lib/room-settings/room-widget-frame/' +
  'room-widget-frame.component.html';

describe('widget iframe boundary', () => {
  it('allows only HTTPS frames in the document CSP', () => {
    const policy =
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
        indexHtml,
      )?.[1];

    expect(policy).toBeDefined();
    expect(policy).toContain('frame-src https:');
    expect(policy).not.toMatch(/frame-src[^;]*(?:http:|data:|blob:|\*)/);
  });

  it('keeps application-owned iframe creation in the reviewed widget host', () => {
    const sources = ['apps/trinity/src', 'libs'];
    const matches = execFileSync(
      'rg',
      [
        '-l',
        '<iframe|createElement(?:<HTMLIFrameElement>)?\\([\'\"]iframe',
        ...sources,
        '-g',
        '!*.spec.ts',
        '-g',
        '!*.stories.ts',
      ],
      { cwd: workspaceRoot, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);

    expect(matches).toEqual([frameTemplate]);
  });
});
