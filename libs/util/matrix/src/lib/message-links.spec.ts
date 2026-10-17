import { describe, expect, it } from 'vitest';
import {
  linkifyMessageText,
  sanitizeMatrixHtml,
  sanitizeOutgoingHtml,
} from './message-html';
import { renderNormalizedTextBody } from './message-view';

/** The sanitized body as a tree, for attribute assertions. */
function parse(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

const firstLink = (html: string): HTMLAnchorElement =>
  parse(html).querySelector('a') as HTMLAnchorElement;

describe('message links that leave Trinity', () => {
  it.each([
    'https://example.org/a',
    'http://example.org/b',
    'HTTPS://EXAMPLE.ORG/c',
  ])('opens %s in a new tab with no opener or referrer', (href) => {
    const link = firstLink(sanitizeMatrixHtml(`<a href="${href}">x</a>`));

    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it.each([
    'https://matrix.to/#/!room:hs',
    'https://matrix.to/#/@alice:hs',
    'matrix:r/general:example.org',
    'matrix:unknown/something',
    'mailto:alice@example.org',
    'ftp://example.org/file',
    'magnet:?xt=urn:btih:abc',
  ])('leaves %s without target or rel', (href) => {
    const link = firstLink(sanitizeMatrixHtml(`<a href="${href}">x</a>`));

    expect(link.hasAttribute('target')).toBe(false);
    expect(link.hasAttribute('rel')).toBe(false);
  });

  it('marks a link whose href starts with a control character the URL parser strips', () => {
    // DOMPurify trims whitespace but keeps U+0001, which the browser's URL parser drops.
    const link = firstLink(
      sanitizeMatrixHtml('<a href="&#x1;https://example.org/a">x</a>'),
    );

    expect(link.getAttribute('href')).toBe('https://example.org/a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('marks a link whose scheme a tab splits, as the URL parser removes it', () => {
    const link = firstLink(
      sanitizeMatrixHtml('<a href="ht&#x9;tps://x.example/a">x</a>'),
    );

    expect(link.getAttribute('href')).toBe('https://x.example/a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('drops a javascript: href behind a control character and leaves the link unmarked', () => {
    const link = firstLink(
      sanitizeMatrixHtml('<a href="&#x1;javascript:alert(1)">x</a>'),
    );

    expect(link.hasAttribute('href')).toBe(false);
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.hasAttribute('rel')).toBe(false);
  });

  it('keeps a permalink behind a control character in Trinity', () => {
    const link = firstLink(
      sanitizeMatrixHtml('<a href="&#x1;https://matrix.to/#/!room:hs">x</a>'),
    );

    expect(link.hasAttribute('target')).toBe(false);
    expect(link.hasAttribute('rel')).toBe(false);
    // Cleaned, so Angular does not mark it `unsafe:` and MatrixLinkDirective can route it.
    expect(link.getAttribute('href')).toBe('https://matrix.to/#/!room:hs');
  });

  it('cleans an href with a long run of spaces inside it in linear time', () => {
    const html = `<a href="&#x1;https://x.example/${' '.repeat(60_000)}a">x</a>`;

    const started = performance.now();
    sanitizeMatrixHtml(html);

    // The whole sanitize call, DOMPurify included: tens of milliseconds when linear (63 ms
    // on a loaded CI runner), about 1.6 s with a backtracking edge trim.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('ignores the target and rel a sender wrote', () => {
    const link = firstLink(
      sanitizeMatrixHtml(
        '<a href="mailto:a@example.org" target="_self" rel="opener">x</a>',
      ),
    );

    expect(link.hasAttribute('target')).toBe(false);
    expect(link.hasAttribute('rel')).toBe(false);
  });

  it('marks the links of a plain-text body the same way', () => {
    const { textHtml } = renderNormalizedTextBody(
      'see https://example.org/x and https://matrix.to/#/!room:hs',
      null,
      false,
      false,
    );
    const links = parse(textHtml ?? '').querySelectorAll('a');

    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1].hasAttribute('target')).toBe(false);
    expect(links[1].hasAttribute('rel')).toBe(false);
  });

  it('linkifies any plain text as a message body, for topics and the composer preview', () => {
    const links = parse(
      linkifyMessageText(
        'see https://example.org/x and https://matrix.to/#/!room:hs',
      ) ?? '',
    ).querySelectorAll('a');

    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1].hasAttribute('target')).toBe(false);
    expect(linkifyMessageText('no links here')).toBeNull();
  });

  it('keeps target and rel off the wire', () => {
    const outgoing = sanitizeOutgoingHtml(
      '<a href="https://example.org/a">x</a>',
    );

    expect(outgoing).not.toContain('target=');
    expect(outgoing).not.toContain('rel=');
  });
});
