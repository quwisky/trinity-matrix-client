import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import {
  DEFAULT_MAX_HIGHLIGHT_LINES,
  sanitizeMatrixHtml,
  setCodeHighlighter,
  setMaxHighlightLines,
} from '@trinity/util/matrix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeHighlightSettingsService } from './code-highlight-settings.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = vi.mocked(Preferences.get);
const set = vi.mocked(Preferences.set);

function build(): CodeHighlightSettingsService {
  return TestBed.configureTestingModule({}).inject(
    CodeHighlightSettingsService,
  );
}

/** A fenced block of `lines` lines, as the sanitizer would receive it. */
const block = (lines: number) =>
  `<pre><code class="language-python">${'x\n'.repeat(lines)}</code></pre>`;

/** One span per line, matching the real highlighter: no token spans a newline. */
function linewiseHighlighter(code: string, _lang: string, doc: Document) {
  const frag = doc.createDocumentFragment();
  code.split('\n').forEach((line, index) => {
    if (index > 0) {
      frag.appendChild(doc.createTextNode('\n'));
    }
    if (line) {
      const span = doc.createElement('span');
      span.className = 'tok-keyword';
      span.textContent = line;
      frag.appendChild(span);
    }
  });
  return frag;
}

describe('CodeHighlightSettingsService', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Both are module-scoped in @trinity/util/matrix and outlive the TestBed.
    setCodeHighlighter(null);
    setMaxHighlightLines(DEFAULT_MAX_HIGHLIGHT_LINES);
  });

  it('colours up to the default until told otherwise', async () => {
    const svc = build();

    await svc.init();

    expect(svc.maxHighlightLines()).toBe(DEFAULT_MAX_HIGHLIGHT_LINES);
    expect(set).not.toHaveBeenCalled();
  });

  it('restores a stored limit as a number, not the string it was stored as', async () => {
    // The config schema declares this setting `number` and compares the declared type
    // against what `read()` actually returns, so a string here fails the drift guard.
    get.mockResolvedValue({ value: '40' });
    const svc = build();

    await svc.init();

    expect(svc.maxHighlightLines()).toBe(40);
  });

  it('applies the restored limit to the sanitizer, not just to its own signal', async () => {
    // The assertion that matters: asserting the signal alone would stay green if `apply()`
    // were dropped from `init()`, and the app would then colour under the default while
    // the settings page showed the stored number.
    get.mockResolvedValue({ value: '3' });
    const svc = build();

    await svc.init();
    setCodeHighlighter(linewiseHighlighter);

    expect(sanitizeMatrixHtml(block(4))).not.toContain('tok-');
    expect(sanitizeMatrixHtml(block(3))).toContain('tok-');
  });

  it('persists a change and applies it immediately', () => {
    const svc = build();
    setCodeHighlighter(linewiseHighlighter);

    svc.setMaxHighlightLines(2);

    expect(svc.maxHighlightLines()).toBe(2);
    expect(set).toHaveBeenCalledWith({
      key: 'trinity.code-highlight-lines',
      value: '2',
    });
    expect(sanitizeMatrixHtml(block(3))).not.toContain('tok-');
  });

  it('takes 0 as no limit at all', () => {
    const svc = build();
    setCodeHighlighter(linewiseHighlighter);

    svc.setMaxHighlightLines(0);

    expect(set).toHaveBeenCalledWith({
      key: 'trinity.code-highlight-lines',
      value: '0',
    });
    expect(sanitizeMatrixHtml(block(5_000))).toContain('tok-');
  });

  it.each([
    ['not a number at all', 'abc'],
    ['negative', '-1'],
    ['fractional', '12.5'],
    ['past the ceiling', '10001'],
    // `Number('')` is 0, which is the value that means "no limit" — an empty entry must
    // not be read as the user having turned the ceiling off.
    ['empty', ''],
    ['blank', '   '],
  ])('ignores a stored limit that is %s', async (_label, stored) => {
    get.mockResolvedValue({ value: stored });
    const svc = build();

    await svc.init();

    expect(svc.maxHighlightLines()).toBe(DEFAULT_MAX_HIGHLIGHT_LINES);
  });

  it('refuses to store a limit it would not accept back', () => {
    const svc = build();

    svc.setMaxHighlightLines(-5);
    svc.setMaxHighlightLines(1.5);
    svc.setMaxHighlightLines(10_001);

    expect(svc.maxHighlightLines()).toBe(DEFAULT_MAX_HIGHLIGHT_LINES);
    expect(set).not.toHaveBeenCalled();
  });

  it('keeps the default when storage is unavailable', async () => {
    get.mockRejectedValue(new Error('no storage'));
    const svc = build();

    await svc.init();

    expect(svc.maxHighlightLines()).toBe(DEFAULT_MAX_HIGHLIGHT_LINES);
  });
});
