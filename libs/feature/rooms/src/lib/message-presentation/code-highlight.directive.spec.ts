import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeHighlightDirective } from './code-highlight.directive';
import { HIGHLIGHT_WORKER_FACTORY } from './code-highlight.worker-client';
import type { HighlightRequest } from './code-highlight.client';
import type { CodeLanguage } from './code-languages';

// A vi.mock factory runs on the FIRST import of the module, so this flag is the proof that
// the grammars are fetched lazily and only when a code block is rendered.
const loaded = vi.hoisted(() => ({ evaluated: false }));
vi.mock('./code-highlight', async (importOriginal) => {
  loaded.evaluated = true;
  return importOriginal();
});

// Counts grammar loads per id, and lets a test hold a load open or fail it once.
const grammars = vi.hoisted(() => ({
  calls: new Map<string, number>(),
  hold: new Map<string, Promise<void>>(),
  failOnce: new Set<string>(),
}));
vi.mock('./code-languages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./code-languages')>();
  const byId = new Map<string, CodeLanguage>();
  const wrap = (entry: CodeLanguage): CodeLanguage => {
    const known = byId.get(entry.id);
    if (known) return known;
    const wrapped: CodeLanguage = {
      id: entry.id,
      load: async () => {
        grammars.calls.set(entry.id, (grammars.calls.get(entry.id) ?? 0) + 1);
        await grammars.hold.get(entry.id);
        if (grammars.failOnce.delete(entry.id)) throw new Error('offline');
        return entry.load();
      },
    };
    byId.set(entry.id, wrapped);
    return wrapped;
  };
  const table = new Map(
    [...actual.CODE_LANGUAGES].map(([fence, entry]) => [fence, wrap(entry)]),
  );
  return {
    ...actual,
    CODE_LANGUAGES: table,
    resolveLanguage: (fence: string) => table.get(fence.toLowerCase()) ?? null,
  };
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
  // The main-thread path unless a test hands the directive a worker.
  let workerFactory: () => Worker | null = () => null;

  beforeEach(async () => {
    workerFactory = () => null;
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: HIGHLIGHT_WORKER_FACTORY, useValue: () => workerFactory() },
      ],
    });
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

  it('leaves an unknown language plain and loads no grammar for it', async () => {
    const before = [...grammars.calls.values()].reduce((a, b) => a + b, 0);
    const view = render(fence('whatever', 'nosuchlang'));
    await view.fixture.whenStable();

    expect(view.tokens()).toBe(0);
    expect(view.host.textContent).toBe('whatever');
    expect([...grammars.calls.values()].reduce((a, b) => a + b, 0)).toBe(
      before,
    );
  });

  it('loads one grammar once for many blocks', async () => {
    const first = render(fence('{"a": 1}', 'json') + fence('[1, 2]', 'json'));
    const second = render(fence('{"b": true}', 'JSON'));

    await vi.waitFor(() => {
      first.fixture.detectChanges();
      second.fixture.detectChanges();
      expect(first.tokens()).toBeGreaterThan(0);
      expect(second.tokens()).toBeGreaterThan(0);
    });
    expect(grammars.calls.get('json')).toBe(1);
  });

  it('highlights a block once its language arrives', async () => {
    let release = () => undefined as void;
    grammars.hold.set('python', new Promise<void>((r) => (release = r)));
    const view = render(fence('def a():\n    return 1', 'python'));

    await vi.waitFor(() => expect(grammars.calls.get('python')).toBe(1));
    view.fixture.detectChanges();
    expect(view.tokens()).toBe(0);

    release();
    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(view.tokens()).toBeGreaterThan(0);
    });
  });

  it('retries a grammar that failed to load', async () => {
    grammars.failOnce.add('rust');
    const view = render(fence('fn a() {}', 'rust'));
    await vi.waitFor(() => expect(grammars.calls.get('rust')).toBe(1));
    await view.fixture.whenStable();
    expect(view.tokens()).toBe(0);

    view.fixture.componentInstance.html.set(
      fence('fn b() { let c = 1; }', 'rust'),
    );
    await vi.waitFor(() => {
      view.fixture.detectChanges();
      expect(view.tokens()).toBeGreaterThan(0);
    });
    expect(grammars.calls.get('rust')).toBe(2);
  });

  it('highlights two languages in one message', async () => {
    const view = render(fence('func main() {}', 'go') + fence('a: 1', 'yaml'));

    await vi.waitFor(() => {
      view.fixture.detectChanges();
      const [go, yaml] = view.host.querySelectorAll('code');
      expect(go.querySelector('[class^="tok-"]')).not.toBeNull();
      expect(yaml.querySelector('[class^="tok-"]')).not.toBeNull();
    });
  });

  describe('with the highlight worker', () => {
    /** Answers each request with its first word as a keyword, or fails on demand. */
    class FakeWorker {
      readonly posted: HighlightRequest[] = [];
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      postMessage(request: HighlightRequest): void {
        this.posted.push(request);
      }
      answer(request: HighlightRequest): void {
        const [word, ...rest] = request.code.split(' ');
        this.onmessage?.({
          data: {
            seq: request.seq,
            lines: [
              [
                [word, 'keyword'],
                [rest.length ? ` ${rest.join(' ')}` : '', null],
              ].filter(([text]) => text),
            ],
          },
        } as MessageEvent);
      }
      fail(): void {
        this.onerror?.(new Event('error'));
      }
      terminate(): void {
        /* nothing to stop */
      }
    }

    let worker: FakeWorker;
    beforeEach(() => {
      worker = new FakeWorker();
      workerFactory = () => worker as unknown as Worker;
    });

    it('applies a worker reply to the block it was sent for', async () => {
      const view = render(fence('const sent = 1;'));
      await vi.waitFor(() => expect(worker.posted).toHaveLength(1));

      worker.answer(worker.posted[0]);
      await vi.waitFor(() => {
        view.fixture.detectChanges();
        expect(view.host.querySelector('.tok-keyword')?.textContent).toBe(
          'const',
        );
      });
      expect(view.host.textContent).toBe('const sent = 1;');
    });

    it('ignores a reply for a block whose text changed', async () => {
      const view = render(fence('let old = 1;'));
      await vi.waitFor(() => expect(worker.posted).toHaveLength(1));

      view.fixture.componentInstance.html.set(fence('var fresh = 2;'));
      view.fixture.detectChanges();
      await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
      worker.answer(worker.posted[0]);
      await view.fixture.whenStable();
      view.fixture.detectChanges();
      expect(view.tokens()).toBe(0);
      expect(view.host.textContent).toBe('var fresh = 2;');

      worker.answer(worker.posted[1]);
      await vi.waitFor(() => {
        view.fixture.detectChanges();
        expect(view.host.querySelector('.tok-keyword')?.textContent).toBe(
          'var',
        );
      });
    });

    it('falls back to the main thread when the worker fails', async () => {
      const view = render(fence('const fallback = 1;'));
      await vi.waitFor(() => expect(worker.posted).toHaveLength(1));

      worker.fail();
      await vi.waitFor(() => {
        view.fixture.detectChanges();
        expect(view.tokens()).toBeGreaterThan(0);
      });
      expect(view.host.textContent).toBe('const fallback = 1;');
    });
  });
});
