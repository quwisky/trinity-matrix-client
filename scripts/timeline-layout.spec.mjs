import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-shape contracts for the modern timeline and composer.
 *
 * Browser tests own rendered geometry and scroll anchoring. These checks pin only the source
 * choices that make those measurements meaningful: the observed row box, density recipes,
 * toolbar containment, and the shared input/preview grid construction.
 */

const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

const variables = read('apps/trinity/src/theme/variables.scss');
const listCss = read(
  'libs/feature/rooms/src/lib/message-list/_message-list-shared.scss',
);
const rowCss = read(
  'libs/feature/rooms/src/lib/message-row/message-row.component.scss',
);
const rowHtml = read(
  'libs/feature/rooms/src/lib/message-row/message-row.component.html',
);
const composerCss = read(
  'libs/feature/rooms/src/lib/message-composer/message-composer.component.scss',
);
const composerHtml = read(
  'libs/feature/rooms/src/lib/message-composer/message-composer.component.html',
);
const toolbarCss = read(
  'libs/components/message-toolbar/src/lib/message-toolbar.component.scss',
);

describe('modern timeline layout contracts', () => {
  it('keeps message rows as the measured border box with in-box group spacing', () => {
    expect(rowCss).toMatch(/:host\s*\{[^}]*display:\s*contents;/s);
    expect(rowCss).toMatch(
      /\.msg\s*\{[\s\S]*?padding:\s*var\(--trinity-space-5\)[^;]*;[\s\S]*?margin:\s*0 calc\(-1 \* var\(--trinity-space-5\)\);[\s\S]*?&:hover/,
    );
    expect(rowCss).toMatch(/\.msg--cont\s*\{[^}]*padding-top:\s*0;/s);
    expect(rowCss).not.toMatch(/\.msg\s*\{[^}]*margin-block/s);
  });

  it('keeps scroller inset and row bleed on the same density-aware token', () => {
    expect(listCss).toMatch(
      /\.scroll\s*\{[^}]*padding:\s*var\(--trinity-space-5\) var\(--trinity-space-5\)/s,
    );
    expect(rowCss).toContain('margin: 0 calc(-1 * var(--trinity-space-5));');
    expect(rowCss).toContain(
      '--message-body-indent: calc(40px + var(--trinity-density-message-column-gap));',
    );
    expect(rowCss.match(/var\(--message-body-indent\)/g)?.length).toBe(4);
    // Precise-pointer floating actions do not consume the message's inline width or measured
    // height. The sole `:has()` track is scoped to the hybrid-touch accessibility override.
    expect(rowCss).toMatch(
      /@media \(any-pointer: coarse\)\s*\{\s*\.msg:has\(\.msg__toolbar\)\s*\{[^}]*padding-inline-end:[^}]*\}\s*\.msg__toolbar\s*\{[^}]*translate:\s*none;[^}]*\}\s*\}/s,
    );
    expect(rowCss).not.toMatch(/\.msg\s*\{[^}]*min-height:/s);
  });

  it('keeps the toolbar attached without participating in row measurement', () => {
    expect(rowCss).toMatch(
      /\.msg__toolbar\s*\{[^}]*position:\s*absolute;[^}]*inset-inline-end:/s,
    );
    expect(rowCss).toMatch(/\.msg__toolbar\s*\{[^}]*translate:/s);
  });

  it('reserves the shield column without narrowing read receipts', () => {
    expect(rowCss).toMatch(
      /\.msg__body\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s,
    );
    expect(rowCss).toMatch(
      /\.msg__shield\s*\{[^}]*grid-row:\s*1;[^}]*grid-column:\s*2;[^}]*margin-inline-start:\s*var\(--trinity-space-3\);/s,
    );
    expect(rowCss).not.toMatch(/\.msg__body\s*\{[^}]*column-gap:/s);
    expect(rowCss).toMatch(
      /\.msg__receipts\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*justify-self:\s*end;/s,
    );
    expect(rowCss).not.toMatch(
      /\.msg__(?:shield|receipts)\s*\{[^}]*position:\s*absolute;/s,
    );
    expect(rowHtml).toMatch(
      /class="msg__content"[\s\S]*class="msg__shield msg__target"[\s\S]*class="msg__receipts msg__target"/,
    );
  });

  it('keeps input and preview in one stable grid cell', () => {
    expect(composerCss).toMatch(
      /\.composer__field\s*\{[^}]*grid-template-columns:\s*auto 1fr auto auto;[^}]*align-items:\s*end;/s,
    );
    expect(composerCss).toMatch(
      /\.composer__preview,\s*\.composer__input\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s,
    );
    expect(composerHtml).toMatch(
      /class="composer__input"[\s\S]*?\[class\.composer__input--hidden\]="previewing\(\)"/,
    );
    expect(composerCss).toMatch(
      /\.composer:has\(\.composer__recording\) \.composer__field\s*\{[^}]*display:\s*none;/s,
    );
    expect(composerCss).toMatch(
      /\.composer__banner\s*\{[\s\S]*?min-height:\s*calc\([\s\S]*?var\(--trinity-density-control-size\)[\s\S]*?var\(--trinity-space-2\)[\s\S]*?\);[\s\S]*?\.composer__cancel/s,
    );
    expect(composerCss).toMatch(
      /\.composer__recording\s*\{[\s\S]*?min-height:\s*var\(--composer-resting-field-height\);[\s\S]*?\.composer__recording-cancel/s,
    );
  });

  it('defines both density recipes and keeps specialized toolbar danger stronger', () => {
    for (const token of [
      '--trinity-density-message-column-gap',
      '--trinity-density-composer-padding-inline',
      '--trinity-density-composer-field-gap',
      '--trinity-density-composer-field-inset',
      '--trinity-density-composer-action-size',
    ]) {
      expect(variables.match(new RegExp(`${token}\\s*:`, 'g'))?.length).toBe(2);
    }
    expect(toolbarCss).toContain('&:hover:where(:not(:disabled))');
    expect(toolbarCss).toMatch(
      /\.toolbar__btn--danger:hover\s*\{[^}]*color:\s*var\(--trinity-danger\)/s,
    );
  });
});
