import { describe, expect, it } from 'vitest';
import {
  renderNormalizedTextBody,
  sanitizeMatrixHtml,
  sanitizeOutgoingHtml,
} from './message-view';

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

  it('keeps target and rel off the wire', () => {
    const outgoing = sanitizeOutgoingHtml(
      '<a href="https://example.org/a">x</a>',
    );

    expect(outgoing).not.toContain('target=');
    expect(outgoing).not.toContain('rel=');
  });
});
