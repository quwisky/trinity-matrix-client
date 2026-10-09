import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeHighlightDirective } from './code-highlight.directive';

// A vi.mock factory runs on the FIRST import of the module, so this flag is the proof that
// the grammars are fetched lazily and only when a code block is rendered.
const loaded = vi.hoisted(() => ({ evaluated: false }));
vi.mock('./code-highlight', async (importOriginal) => {
  loaded.evaluated = true;
  return importOriginal();
});

@Component({
  imports: [CodeHighlightDirective],
  template: `<div [innerHTML]="html()" [trnCodeHighlight]="html()"></div>`,
})
class HostComponent {
  readonly html = signal('');
}

const fence = (source: string, lang = 'typescript') =>
  sanitizeMatrixHtml(
    `<pre><code class="language-${lang}">${source}</code></pre>`,
  );

describe('CodeHighlightDirective', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] });
  });

  function render(html: string) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(html);
    fixture.detectChanges();
    const host = fixture.nativeElement.firstElementChild as HTMLElement;
    return {
      fixture,
      host,
      tokens: () => host.querySelectorAll('[class^="tok-"]').length,
    };
  }

  it('does not load the highlighter for messages without a code block', async () => {
    const view = render('<p>hello</p><pre><code>no language</code></pre>');
    await view.fixture.whenStable();

    expect(loaded.evaluated).toBe(false);
  });

  it('shows plain code first and swaps in highlighting when the grammars arrive', async () => {
    const source = 'const a = 1;\nconst b = "x";\n';
    const view = render(fence(source));

    expect(view.tokens()).toBe(0);
    expect(view.host.textContent).toBe(source);
    await vi.waitFor(() => expect(loaded.evaluated).toBe(true));

    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(view.tokens()).toBeGreaterThan(0);
    });
    expect(view.host.textContent).toBe(source);
  });

  it('keeps the numbered line wrappers when highlighting a long block', async () => {
    const source = Array.from({ length: 8 }, (_, i) => `let v${i} = ${i};`);
    const view = render(fence(source.join('\n')));

    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(view.tokens()).toBeGreaterThan(0);
    });
    const lines = view.host.querySelectorAll('code > .code-line');
    expect(lines).toHaveLength(8);
    expect(lines[3].textContent).toBe('let v3 = 3;');
  });

  it('highlights again when the message body is replaced', async () => {
    const view = render(fence('const a = 1;'));
    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(view.tokens()).toBeGreaterThan(0);
    });

    view.fixture.componentInstance.html.set(fence('let b = 2;'));
    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(view.host.textContent).toBe('let b = 2;');
      expect(view.tokens()).toBeGreaterThan(0);
    });
  });

  it('leaves a block over the size cap as plain code', async () => {
    const big = `const a = 1;\n`.repeat(400); // 5,200 chars
    const view = render(fence(big) + fence('const small = 1;'));

    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(view.tokens()).toBeGreaterThan(0);
    });
    const [bigCode, smallCode] = view.host.querySelectorAll('code');
    expect(bigCode.querySelector('[class^="tok-"]')).toBeNull();
    expect(smallCode.querySelector('[class^="tok-"]')).not.toBeNull();
  });

  it('leaves a block containing sender markup alone', async () => {
    const view = render(
      sanitizeMatrixHtml(
        '<pre><code class="language-typescript"><b>const</b> a = 1;</code></pre>' +
          '<pre><code class="language-typescript">let c = 1;</code></pre>',
      ),
    );

    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(
        view.host.querySelectorAll('code')[1].querySelector('span'),
      ).not.toBeNull();
    });
    expect(view.host.querySelector('code b')?.textContent).toBe('const');
    expect(
      view.host.querySelectorAll('code')[0].querySelector('[class^="tok-"]'),
    ).toBeNull();
  });

  it('leaves an unknown language plain', async () => {
    const view = render(fence('whatever', 'nosuchlang'));
    await vi.waitFor(() => expect(loaded.evaluated).toBe(true));
    await view.fixture.whenStable();

    expect(view.tokens()).toBe(0);
    expect(view.host.textContent).toBe('whatever');
  });
});
