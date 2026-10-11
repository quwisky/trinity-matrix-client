import { afterEach, describe, expect, it, vi } from 'vitest';
import { concat } from './image-metadata.fixture';
import {
  joinParts,
  strippableFormat,
  stripImageMetadata,
} from './image-metadata';
import {
  CLEAN_SVG,
  ILLUSTRATOR_SVG,
  INKSCAPE_SVG,
  INKSCAPE_SVG_STRIPPED,
  SVG_NS,
  manyAttributesSvg,
  manyElementsSvg,
  utf8,
} from './svg-metadata.fixture';

function strippedText(input: Uint8Array<ArrayBuffer>): string {
  const result = stripImageMetadata(input);
  if (result.kind !== 'stripped') {
    throw new Error(`expected a strip, got ${result.kind}/${result.reason}`);
  }
  expect(result.format).toBe('svg');
  const bytes = joinParts(result.parts);
  expect(bytes.byteLength).toBe(result.byteLength);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parse(text: string): Document {
  return new DOMParser().parseFromString(text, 'image/svg+xml');
}

function expectMalformed(input: Uint8Array<ArrayBuffer>): void {
  expect(stripImageMetadata(input)).toEqual({
    kind: 'unchanged',
    reason: 'malformed',
  });
}

describe('stripImageMetadata: SVG', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['a bare root', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['a root with attributes on later lines', '<svg\n  width="1">'],
    ['a byte order mark and whitespace', '﻿ \n\t<svg>'],
    [
      'an XML declaration, comments, an instruction and a doctype',
      '<?xml version="1.0"?>\n<!-- a > b -->\n<?xml-stylesheet href="a.css"?>\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd" [\n' +
        '  <!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">\n]>\n<svg>',
    ],
  ])('recognises an SVG starting with %s', (_label, text) => {
    expect(strippableFormat(utf8(text))).toBe('svg');
  });

  it.each([
    ['an HTML page', '<!DOCTYPE html><html><svg></svg></html>'],
    ['another XML document', '<?xml version="1.0"?><rss version="2.0"/>'],
    ['a different element', '<svgx/>'],
    ['an unterminated comment', '<!-- <svg>'],
    ['plain text mentioning svg', 'svg files are vector images'],
    ['a root past the sniffed prefix', `<!--${' '.repeat(5000)}--><svg>`],
  ])('does not take %s for an SVG', (_label, text) => {
    expect(strippableFormat(utf8(text))).toBeNull();
  });

  it('removes metadata, comments and editor namespaces, keeping title and desc', () => {
    const out = strippedText(utf8(INKSCAPE_SVG));

    for (const marker of [
      'Alice Example',
      'Berlin',
      '/home/alice',
      'inkscape',
      'sodipodi',
      'rdf:',
      'metadata',
      '<!--',
    ]) {
      expect(out.includes(marker), marker).toBe(false);
    }
    expect(out).toBe(INKSCAPE_SVG_STRIPPED);
  });

  it('removes Adobe Illustrator namespaces and private data, keeping xlink and xml:space', () => {
    const out = strippedText(utf8(ILLUSTRATOR_SVG));

    expect(out.includes('Alice Example')).toBe(false);
    expect(out.includes('Adobe Illustrator')).toBe(false);
    expect(out.includes('ns.adobe.com/Graphs')).toBe(false);
    expect(out.includes('i:')).toBe(false);
    const doc = parse(out);
    const root = doc.firstElementChild;
    expect(root?.namespaceURI).toBe(SVG_NS);
    expect(root?.getAttribute('xml:space')).toBe('preserve');
    expect(root?.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(doc.getElementsByTagNameNS(SVG_NS, 'rect')).toHaveLength(1);
    const use = doc.getElementsByTagNameNS(SVG_NS, 'use')[0];
    expect(use?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(
      '#square',
    );
    // The switch keeps its fallback, now that the Illustrator-only branch is empty.
    expect(doc.getElementsByTagNameNS(SVG_NS, 'foreignObject')).toHaveLength(1);
  });

  it('keeps the doctype and instructions of an SVG with only a comment to remove', () => {
    const input = CLEAN_SVG.replace('<title>', '<!-- Alice Example --><title>');

    const out = strippedText(utf8(input));

    expect(out).toBe(CLEAN_SVG);
  });

  it('still declares the svg prefix where an element uses it', () => {
    const out = strippedText(
      utf8(
        `<svg xmlns="${SVG_NS}" xmlns:svg="${SVG_NS}"><!-- x --><svg:rect width="1"/></svg>`,
      ),
    );

    const rect = parse(out).getElementsByTagNameNS(SVG_NS, 'rect');
    expect(rect).toHaveLength(1);
    expect(rect[0]?.getAttribute('width')).toBe('1');
  });

  it('reports an SVG without metadata as clean, without reserializing it', () => {
    expect(stripImageMetadata(utf8(CLEAN_SVG))).toEqual({
      kind: 'unchanged',
      reason: 'clean',
    });
  });

  it('writes UTF-8 and keeps non-ASCII text', () => {
    const out = strippedText(
      utf8(
        '﻿<svg xmlns="http://www.w3.org/2000/svg"><!-- x --><text>Grüße</text></svg>\n',
      ),
    );

    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Grüße</text></svg>\n',
    );
  });

  it.each([
    [
      'is not well-formed',
      utf8('<svg xmlns="http://www.w3.org/2000/svg"><g><!-- x --></svg>'),
    ],
    [
      'is not valid UTF-8',
      concat(
        utf8('<svg xmlns="http://www.w3.org/2000/svg"><!-- '),
        Uint8Array.of(0xff, 0xfe),
        utf8(' --></svg>'),
      ),
    ],
    [
      'declares another encoding',
      utf8(
        '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg"><!-- x --></svg>',
      ),
    ],
    [
      'has a root outside the SVG namespace',
      utf8('<svg xmlns="http://example.com/not-svg"><!-- x --></svg>'),
    ],
    ['has no namespace', utf8('<svg><!-- x --></svg>')],
  ])('leaves an SVG that %s unchanged', (_label, input) => {
    expectMalformed(input);
  });

  it('leaves an SVG unchanged where the platform has no XML parser', () => {
    vi.stubGlobal('DOMParser', undefined);

    expectMalformed(utf8(INKSCAPE_SVG));
  });

  it('leaves a very large SVG unchanged without parsing it', () => {
    const input = utf8(
      `<svg xmlns="${SVG_NS}"><!-- x -->${' '.repeat(16 * 1024 * 1024)}</svg>`,
    );

    const started = performance.now();
    const result = stripImageMetadata(input);
    const elapsed = performance.now() - started;

    expect(result).toEqual({ kind: 'unchanged', reason: 'malformed' });
    expect(elapsed).toBeLessThan(100);
  });

  it('caps the elements one strip may visit', () => {
    expect(stripImageMetadata(manyElementsSvg(10_000)).kind).toBe('stripped');
    expectMalformed(manyElementsSvg(140_000));
  });

  it('leaves an SVG with an element of more than 1024 attributes unchanged', () => {
    expect(stripImageMetadata(manyAttributesSvg(1, 1_024)).kind).toBe(
      'stripped',
    );
    expectMalformed(manyAttributesSvg(1, 1_025));
  });

  it('counts attributes against the walk budget', () => {
    // 129 elements of 1,024 kept attributes: under the per-element cap, over the budget.
    const kept = { editor: false };
    expect(stripImageMetadata(manyAttributesSvg(127, 1_024, kept)).kind).toBe(
      'stripped',
    );
    expectMalformed(manyAttributesSvg(129, 1_024, kept));
  });

  it('bounds the work of removing attributes, which grows with each element', () => {
    // Emptying a 1,024-attribute element costs about 1,024²/2 attribute scans.
    expect(stripImageMetadata(manyAttributesSvg(3, 1_024)).kind).toBe(
      'stripped',
    );
    expectMalformed(manyAttributesSvg(4, 1_024));
  });
});
