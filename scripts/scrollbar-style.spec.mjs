import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineStyleSheets } from './inline-styles.mjs';

const workspaceRoot = join(import.meta.dirname, '..');
const GLOBAL_STYLESHEET = 'apps/trinity/src/global.scss';
const TOKEN_STYLESHEET = 'apps/trinity/src/theme/variables.scss';
const HIDDEN_UTILITY_STYLESHEET = 'apps/trinity/src/theme/spartan.css';

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const read = (file) =>
  stripComments(readFileSync(join(workspaceRoot, file), 'utf8'));

const stylesheetFiles = globSync(['apps/**/*.{css,scss}', 'libs/**/*.scss'], {
  cwd: workspaceRoot,
}).sort();

const scrollbarOwner = (source) =>
  /scrollbar-(?:color|width)\s*:|::-(?:webkit-)?scrollbar/.test(source);

describe('shared scrollbar design', () => {
  it('owns every visible scrollbar design in the global stylesheet', () => {
    const owners = stylesheetFiles.filter((file) => scrollbarOwner(read(file)));

    expect(owners).toEqual([GLOBAL_STYLESHEET, HIDDEN_UTILITY_STYLESHEET]);
    expect(
      inlineStyleSheets().filter(({ css }) =>
        scrollbarOwner(stripComments(css)),
      ),
    ).toEqual([]);
  });

  it('uses one semantic token contract for vertical and horizontal bars', () => {
    const variables = read(TOKEN_STYLESHEET);
    const global = read(GLOBAL_STYLESHEET);

    expect(variables).toContain(
      '--trinity-scrollbar-size: var(--trinity-space-3);',
    );
    expect(variables).toContain(
      '--trinity-scrollbar-radius: var(--trinity-radius-sm);',
    );
    expect(variables).toContain(
      '--trinity-scrollbar-thumb: var(--trinity-text-muted);',
    );
    expect(variables).toContain('--trinity-scrollbar-track: transparent;');

    expect(global).toMatch(
      /::-webkit-scrollbar\s*\{[^}]*width:\s*var\(--trinity-scrollbar-size\);[^}]*height:\s*var\(--trinity-scrollbar-size\);/s,
    );
    expect(global).toMatch(
      /::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*var\(--trinity-scrollbar-radius\);[^}]*background:\s*var\(--trinity-scrollbar-thumb\);/s,
    );
    expect(global).toMatch(
      /::-webkit-scrollbar-(?:track|corner)[\s\S]*background:\s*var\(--trinity-scrollbar-track\);/,
    );
    expect(global).not.toContain('scrollbar-gutter');
  });

  it('keeps hidden scrollbars as a narrow, explicit exception', () => {
    const global = read(GLOBAL_STYLESHEET);
    const utility = read(HIDDEN_UTILITY_STYLESHEET);

    expect(global).toContain(':where(:not(.no-scrollbar))');
    expect(global).not.toContain(':not(.no-scrollbar *)');
    expect(utility).toMatch(
      /@utility no-scrollbar\s*\{[^}]*scrollbar-width:\s*none;/s,
    );
    expect(utility).toMatch(/::-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  });
});
