import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown-render';

describe('renderMarkdown — custom emoji (MSC2545)', () => {
  const emoticons = new Map([
    ['wave', 'mxc://hs/wave'],
    ['cat', 'mxc://hs/cat'],
  ]);
  const images = (html: string) => [
    ...new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelectorAll('img'),
  ];

  it('replaces a known :code: with an inline emoji image', () => {
    const { html } = renderMarkdown('hi :wave: there', emoticons);
    const [image, ...rest] = images(html);

    expect(rest).toEqual([]);
    expect(
      Object.fromEntries(
        [...image.attributes].map((attribute) => [
          attribute.name,
          attribute.value,
        ]),
      ),
    ).toEqual({
      'data-mx-emoticon': '',
      src: 'mxc://hs/wave',
      alt: ':wave:',
      title: ':wave:',
      height: '32',
    });
    expect(html).toContain('hi <img');
    expect(html).toContain('> there');
  });

  it('leaves unknown codes and codes inside code spans as text', () => {
    const { html } = renderMarkdown(
      ':nope: :cat: `:wave:`\n\n```\n:cat:\n```',
      emoticons,
    );

    expect(images(html).map((image) => image.getAttribute('alt'))).toEqual([
      ':cat:',
    ]);
    expect(html).toContain(':nope:');
    expect(html).toContain('<code>:wave:</code>');
    expect(html).toContain(':cat:\n</code></pre>');
  });

  it('needs a boundary on both sides, so a time stays text', () => {
    const times = new Map([['30', 'mxc://hs/thirty']]);

    expect(images(renderMarkdown('10:30:45', times).html)).toEqual([]);
    expect(images(renderMarkdown('a:wave:', emoticons).html)).toEqual([]);
    expect(images(renderMarkdown(':wave:b', emoticons).html)).toEqual([]);
    expect(images(renderMarkdown(':nope:wave:', emoticons).html)).toEqual([]);
    expect(images(renderMarkdown('hi :wave:', emoticons).html)).toHaveLength(1);
    expect(images(renderMarkdown('(:wave:)!', emoticons).html)).toHaveLength(1);
  });

  it('converts adjacent codes, which share one boundary', () => {
    const { html } = renderMarkdown(':cat::wave:', emoticons);

    expect(images(html).map((image) => image.getAttribute('alt'))).toEqual([
      ':cat:',
      ':wave:',
    ]);
  });

  it('marks an emoji-only message as formatted', () => {
    expect(renderMarkdown(':wave:', emoticons).formatted).toBe(true);
    expect(renderMarkdown(':wave:').formatted).toBe(false);
  });

  it('drops a pack image whose url is not mxc to its alt text', () => {
    const { html } = renderMarkdown(
      ':bad:',
      new Map([['bad', 'https://x/bad.png']]),
    );

    expect(images(html)).toEqual([]);
    expect(html).toContain(':bad:');
  });
});

// `formatted` decides whether a message goes on the wire as plain `body` or gains a
// `formatted_body`. It is a round-trip test — render, strip the tags, compare — so
// turning on `breaks` (a single newline becomes <br>) put it at risk: <br> contributes
// nothing to textContent, and without restoring it every multi-line plain message would
// have been promoted to HTML.
describe('renderMarkdown — plain vs formatted', () => {
  it.each([
    ['a single line', 'hello there'],
    ['a soft line break', 'line one\nline two'],
    ['a paragraph break', 'a\n\nb'],
    ['several blank lines', 'a\n\n\nb'],
    ['a two-space hard break', 'x  \ny'],
    ['a Windows line ending', 'a\r\nb'],
    ['trailing blanks before a Windows line ending', 'x \t\r\ny'],
    ['trailing blanks before a lone carriage return', 'x  \ry'],
    ['trailing blanks before a line separator', 'x \t\u2028y'],
    ['trailing whitespace', 'hello   '],
    ['a bare URL', 'https://a.test/x'],
    ['characters that merely escape', '5 < 3 & 4 > 2'],
    ['an underscore inside a word', 'snake_case_word'],
    ['asterisks used as multiplication', '2 * 3 * 4'],
    ['a Windows path', 'C:\\path\\to'],
    ['a hash that is not a heading', '#hashtag'],
    ['nothing at all', ''],
  ])('sends %s as plain text', (_label, text) => {
    expect(renderMarkdown(text).formatted).toBe(false);
  });

  it.each([
    ['emphasis', '**bold**'],
    ['emphasis beside a line break', '**bold**\nline two'],
    ['a heading', '# H'],
    ['a quote', '> q'],
    ['a bullet list', '- a\n- b'],
    ['inline code', '`code`'],
    ['a fenced block', '```js\nlet a = 1;\n```'],
    ['a task list', '- [x] done'],
    ['strikethrough', '~~gone~~'],
  ])('sends %s as HTML', (_label, text) => {
    expect(renderMarkdown(text).formatted).toBe(true);
  });

  it('keeps a soft line break as a <br> rather than losing it', () => {
    // The bug this whole change exists for: the plain branch renders under
    // `white-space: pre-wrap` and kept the newline, but the formatted branch emitted a
    // bare \n under `white-space: normal`, which collapsed it to a space — so bolding
    // one word silently deleted every line break in the message.
    expect(renderMarkdown('**bold**\nline two').html).toContain('<br>');
  });

  it('leaves an indented single line as plain text (documented false negative)', () => {
    // "    code" is a code block to marked, but both sides normalise to "code" so it
    // compares equal. Unreachable from the composer, which trims first, and harmless
    // under pre-wrap — pinned so it cannot silently widen.
    expect(renderMarkdown('    code').formatted).toBe(false);
    expect(renderMarkdown('x\n\n    code').formatted).toBe(true);
  });

  it('levels trailing whitespace in linear time across a long blank run', () => {
    // A long tab run that is not at the end of its line made the anchored trailing-blank
    // trim retry the run from every start position. Tabs, because marked's own handling
    // of a long space run is outside this comparison. The bound covers marked and the
    // DOM parse too, so it is looser than the bare URL trim's; the quadratic trim took
    // seconds here.
    const text = `a${'\t'.repeat(60_000)}b`;

    const start = performance.now();
    renderMarkdown(text);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(250);
  });

  it('treats input that sanitizes away to nothing as plain text', () => {
    // Sending an empty formatted_body is worse than sending the text.
    expect(renderMarkdown('<!-- just a comment -->')).toEqual({
      formatted: false,
      html: '',
    });
  });
});

describe('renderMarkdown — outgoing sanitization', () => {
  it('renders GFM task lists as ballot glyphs, not checkboxes', () => {
    // `input` is in neither allowlist, so marked's <input type="checkbox"> was stripped
    // on the way out and the done/not-done state was lost before the event was sent.
    const { html } = renderMarkdown('- [x] done\n- [ ] todo');

    expect(html).toContain('☑ done');
    expect(html).toContain('☐ todo');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('checked');
    expect(html).not.toContain('type=');
  });

  it('sends a remote image as a link rather than a broken one', () => {
    // Matrix requires an mxc: source, so the <img> would sanitize to an empty box — and
    // because every client prefers formatted_body over body, the URL would vanish with it.
    const { html } = renderMarkdown('![pic](https://x.test/a.png)');

    expect(html).toContain('<a href="https://x.test/a.png">pic</a>');
    expect(html).not.toContain('<img');
  });

  it('points a linked remote image at the target, not at the image', () => {
    // `[![badge](img)](target)` — the badge-linking shape. Rendering the image as an <a>
    // inside the link's <a> is not representable: the parser splits the nested anchors and
    // the message goes out as an empty link plus a link to the IMAGE, losing the target.
    const { html } = renderMarkdown(
      '[![badge](https://img.test/b.svg)](https://target.test/x)',
    );

    expect(html).toContain('<a href="https://target.test/x">badge</a>');
    expect(html).not.toContain('img.test');
    expect(html).not.toMatch(/<a[^>]*><\/a>/);
  });

  it('never puts a data: image on the wire', () => {
    // Matrix requires an mxc: source, so a base64 payload arrives as the empty box this
    // renderer exists to prevent — after shipping the whole blob, which on a real image
    // would blow the 65 KiB event limit on its own.
    const { html } = renderMarkdown('![diagram](data:image/png;base64,AAAA)');

    expect(html).not.toContain('base64');
    expect(html).not.toContain('<img');
    expect(html).toContain('diagram');
  });

  it('applies the mxc-only image rule to raw HTML too', () => {
    // `image()` only sees markdown image tokens — marked hands raw HTML straight through, so
    // the same payload walked out the other door. Both are settled on the way out now.
    const data = renderMarkdown(
      '<img src="data:image/png;base64,AAAA" alt="diagram">',
    );
    expect(data.html).not.toContain('base64');
    expect(data.html).not.toContain('<img');
    expect(data.html).toContain('diagram');

    // A remote source keeps its src stripped by the allowlist, which left a src-less <img> —
    // the empty box the markdown renderer exists to avoid.
    const remote = renderMarkdown('<img src="https://x.test/a.png" alt="pic">');
    expect(remote.html).not.toContain('<img');
    expect(remote.html).toContain('pic');
  });

  it('does not fall back to a data: URI as the link text', () => {
    // `text || href` would otherwise put the payload on the wire as the caption instead.
    const { html } = renderMarkdown('![](data:image/png;base64,AAAA)');

    expect(html).not.toContain('base64');
  });

  it('keeps an image whose source Matrix does carry', () => {
    const { html } = renderMarkdown('![pic](mxc://hs/abc)');

    expect(html).toContain('<img src="mxc://hs/abc"');
    expect(html).toContain('alt="pic"');
  });

  it('drops tags Angular allowed but Matrix does not', () => {
    // The point of routing sends through the Matrix allowlist: the client can no longer
    // emit a formatted_body its own renderer would strip.
    for (const raw of [
      '<audio src="x"></audio>',
      '<mark>x</mark>',
      '<ins>x</ins>',
    ]) {
      const { html } = renderMarkdown(raw);
      expect(html, raw).not.toMatch(/<(audio|mark|ins)\b/);
    }
  });

  it('drops the href from a relative or fragment link', () => {
    // The Matrix allowlist requires an absolute scheme on href, so a relative link keeps
    // its text and loses its target. It always rendered that way on arrival too — this
    // just stops us sending one that only ever looked like a link.
    for (const raw of ['[docs](/help/start)', '[top](#intro)']) {
      const { html } = renderMarkdown(raw);
      expect(html, raw).not.toContain('href');
      expect(html, raw).toContain('</a>');
    }
    expect(renderMarkdown('[ok](https://a.test/x)').html).toContain(
      'href="https://a.test/x"',
    );
  });

  it('still strips script and event handlers', () => {
    const { html } = renderMarkdown(
      '<img src=x onerror=alert(1)><script>bad()</script>',
    );

    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
  });
});

describe('renderMarkdown long space runs (#1306)', () => {
  /** Below the shield threshold, rendered by marked as-is: the reference output. */
  const NATIVE = ' '.repeat(31);
  const LONG = ' '.repeat(40);
  const templates: ((run: string) => string)[] = [
    (s) => `a${s}b`,
    (s) => `**bold**${s}_italic_ and *more*${s}text`,
    (s) => `x_y${s}_z_`,
    (s) => `\`code${s}span\``,
    (s) => '```\nfenced' + s + 'block\n```',
    (s) => `[link${s}text](https://example.org) after${s}it`,
    (s) => `- item${s}one\n- item two`,
    (s) => `| a${s}b | c |\n| --- | --- |\n| d${s}e | f |`,
    (s) => `> quoted${s}words`,
    (s) => `see https://example.org${s}and www.example.org${s}too`,
    (s) => `@alice:example.org${s}#room:example.org`,
    (s) => `line one${s}\nline two`,
    (s) => `trailing words${s}`,
  ];

  it.each(templates.map((t, i) => [i, t] as const))(
    'renders template %i exactly as marked would',
    (_, template) => {
      const native = renderMarkdown(template(NATIVE));
      const long = renderMarkdown(template(LONG));
      expect(long.formatted).toBe(native.formatted);
      expect(long.html).toBe(native.html.split(NATIVE).join(LONG));
    },
  );

  it('renders a 60,000-space run between two words without stalling', () => {
    const run = ' '.repeat(60_000);
    const started = performance.now();
    const rendered = renderMarkdown(`a${run}b`);
    // marked alone takes ~1.7 s here: its inline text rule rescans the run at every space.
    expect(performance.now() - started).toBeLessThan(500);
    expect(rendered.html).toBe(`<p>a${run}b</p>\n`);
  });

  it('leaves text that already holds the shield characters to marked', () => {
    const text = `a${LONG}b  c`;
    expect(renderMarkdown(text).html).toContain(`a${LONG}b  c`);
  });
});
