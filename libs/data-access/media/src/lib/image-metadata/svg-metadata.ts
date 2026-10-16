import {
  CLEAN,
  MALFORMED,
  MAX_WALK_STEPS,
  type Bytes,
  type FormatStrip,
} from './byte-parts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const ELEMENT_NODE = 1;
const COMMENT_NODE = 8;

/**
 * Namespaces of editor state and descriptive metadata. Their elements and attributes do
 * not affect rendering, yet carry file paths, user names, window layouts and RDF records:
 * Inkscape/Sodipodi, Sketch, Affinity (Serif), RDF, Dublin Core, Creative Commons and XMP.
 * Adobe's own namespaces (Illustrator's `i:` and `x:`, graphs, variables, ...) all live
 * under `http://ns.adobe.com/` and are matched by that prefix.
 */
const DROPPED_NAMESPACES = new Set([
  'http://www.inkscape.org/namespaces/inkscape',
  'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
  'http://www.bohemiancoding.com/sketch/ns',
  'http://www.serif.com/',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://purl.org/dc/elements/1.1/',
  'http://purl.org/dc/terms/',
  'http://creativecommons.org/ns#',
  'http://web.resource.org/cc/',
  'adobe:ns:meta/',
]);
const DROPPED_NAMESPACE_PREFIX = 'http://ns.adobe.com/';

/**
 * How far into a file the SVG root is looked for. Editors write an XML declaration, a
 * generator comment and perhaps a doctype first, all well under this.
 */
export const SVG_SNIFF_BYTES = 4096;

/**
 * Larger SVGs go out unchanged. The platform parser builds a full DOM on the calling
 * thread; the cap keeps a crafted or huge drawing from stalling the app for long.
 */
const MAX_SVG_BYTES = 16 * 1024 * 1024;

/**
 * Upper bound on one element's attributes. Removing an attribute costs time proportional to
 * the element's attribute count in Blink, so stripping thousands from one element is
 * quadratic and freezes Chromium. Real drawings have a few dozen at most.
 */
const MAX_ELEMENT_ATTRIBUTES = 1024;

/**
 * Upper bound on attributes across the drawing, kept apart from the element walk
 * (`MAX_WALK_STEPS`): a large Inkscape drawing (125,000 paths, 6 attributes each) stays
 * well under it.
 */
const MAX_ATTRIBUTES = 1 << 21;

/**
 * Upper bound on attribute removal work: each removal counts the attributes its element
 * still has. Real editor files stay far below it; without it, many elements near the
 * per-element cap would still stall Chromium for a noticeable time.
 */
const MAX_REMOVAL_WORK = 1 << 21;

const BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * Whether `bytes` start, within {@link SVG_SNIFF_BYTES}, with an `<svg` root: after an
 * optional UTF-8 byte order mark, whitespace, the XML declaration, processing
 * instructions, comments and a doctype. UTF-16 files are not recognised.
 */
export function isSvg(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SVG_SNIFF_BYTES);
  let at = BOM.every((byte, i) => bytes[i] === byte) ? BOM.length : 0;
  for (;;) {
    while (at < end && isSpace(bytes[at] ?? 0)) at++;
    if (startsWith(bytes, at, end, '<?')) {
      at = after(bytes, at + 2, end, '?>');
    } else if (startsWith(bytes, at, end, '<!--')) {
      at = after(bytes, at + 4, end, '-->');
    } else if (startsWith(bytes, at, end, '<!DOCTYPE')) {
      at = afterDoctype(bytes, at + 9, end);
    } else if (startsWith(bytes, at, end, '<svg') && at + 4 < end) {
      const next = bytes[at + 4] ?? 0;
      return isSpace(next) || next === 0x3e || next === 0x2f; // ">" or "/"
    } else {
      return false;
    }
    if (at < 0) return false;
  }
}

/**
 * Remove metadata from an SVG drawing: `<metadata>` elements, comments, and the elements,
 * attributes and namespace declarations of editor and metadata namespaces (see
 * {@link DROPPED_NAMESPACES}). `<title>` and `<desc>` are kept for accessibility, and so is
 * everything that renders. Scripts and external references are not touched: this removes
 * metadata, it does not sanitise the drawing.
 *
 * The file is parsed with the platform XML parser and serialized again as UTF-8, so the
 * output can differ in formatting (attribute quoting, empty-element syntax, a doctype's
 * internal subset, whose entities are already expanded). A file that is not valid UTF-8,
 * declares another encoding, does not parse, has no SVG root, or exceeds a cap (16 MiB,
 * {@link MAX_ELEMENT_ATTRIBUTES} on one element, {@link MAX_ATTRIBUTES} in all,
 * `MAX_WALK_STEPS` elements and comments, {@link MAX_REMOVAL_WORK})
 * goes out unchanged, as does every SVG where the platform has no `DOMParser`.
 */
export function stripSvg(bytes: Bytes): FormatStrip {
  if (bytes.length > MAX_SVG_BYTES) return MALFORMED;
  if (
    typeof DOMParser === 'undefined' ||
    typeof XMLSerializer === 'undefined'
  ) {
    return MALFORMED;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return MALFORMED;
  }
  const declaration = /^<\?xml\s[^>]*\?>/u.exec(text)?.[0] ?? '';
  const encoding = /\sencoding\s*=\s*["']([^"']*)["']/u.exec(declaration)?.[1];
  if (encoding !== undefined && !/^utf-?8$/iu.test(encoding)) return MALFORMED;

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  // The parsed drawing's root element (a document has exactly one element child).
  const root = doc.firstElementChild;
  if (
    root?.namespaceURI !== SVG_NS ||
    root.localName !== 'svg' ||
    doc.getElementsByTagNameNS('*', 'parsererror').length > 0
  ) {
    return MALFORMED;
  }

  let removed = false;
  let steps = 0;
  let attributeCount = 0;
  let removalWork = 0;
  /** `xmlns:prefix` declarations of the SVG namespace itself; see below. */
  const svgPrefixes: Attr[] = [];
  for (const node of Array.from(doc.childNodes)) {
    if (node.nodeType === COMMENT_NODE) {
      node.remove();
      removed = true;
    }
  }
  const pending: Element[] = [root];
  for (let element = pending.pop(); element; element = pending.pop()) {
    // Attributes have their own budgets, per element and in all, so the work stays bounded.
    const attributes = element.attributes;
    if (attributes.length > MAX_ELEMENT_ATTRIBUTES) return MALFORMED;
    attributeCount += attributes.length;
    if (attributeCount > MAX_ATTRIBUTES) return MALFORMED;
    for (const attribute of Array.from(attributes)) {
      if (dropsAttribute(attribute)) {
        removalWork += attributes.length; // the live count, shrinking as they go
        if (removalWork > MAX_REMOVAL_WORK) return MALFORMED;
        element.removeAttributeNode(attribute);
        removed = true;
      } else if (
        attribute.namespaceURI === XMLNS_NS &&
        attribute.prefix === 'xmlns' &&
        attribute.value === SVG_NS
      ) {
        svgPrefixes.push(attribute);
      }
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType !== COMMENT_NODE && child.nodeType !== ELEMENT_NODE) {
        continue; // text, CDATA and processing instructions stay
      }
      if (++steps > MAX_WALK_STEPS) return MALFORMED;
      if (child.nodeType === COMMENT_NODE) {
        child.remove();
        removed = true;
      } else {
        if (dropsElement(child as Element)) {
          child.remove();
          removed = true;
        } else {
          pending.push(child as Element);
        }
      }
    }
  }
  if (!removed) return CLEAN;
  // Inkscape declares the SVG namespace twice (`xmlns` and `xmlns:svg`). Some serializers
  // then write the root as `<svg:svg>`; without the redundant declaration they keep the
  // element's own prefix and declare `svg:` again wherever an element still uses it.
  for (const attribute of svgPrefixes)
    attribute.ownerElement?.removeAttributeNode(attribute);

  const serializer = new XMLSerializer();
  const body = Array.from(doc.childNodes, (node) =>
    serializer.serializeToString(node),
  ).join('\n');
  // A final newline survives; found without a regex that could backtrack over long runs.
  const finalNewline = text.slice(text.trimEnd().length).includes('\n');
  const prolog = declaration ? `${declaration}\n` : '';
  const out = `${prolog}${body}${finalNewline ? '\n' : ''}`;
  return {
    kind: 'stripped',
    parts: [new TextEncoder().encode(out) as Bytes],
  };
}

function isDropped(namespace: string | null): boolean {
  return (
    namespace !== null &&
    (DROPPED_NAMESPACES.has(namespace) ||
      namespace.startsWith(DROPPED_NAMESPACE_PREFIX))
  );
}

function dropsElement(element: Element): boolean {
  return (
    (element.namespaceURI === SVG_NS && element.localName === 'metadata') ||
    isDropped(element.namespaceURI)
  );
}

/** Attributes in a dropped namespace, and the `xmlns:` declarations that bind one. */
function dropsAttribute(attribute: Attr): boolean {
  if (attribute.namespaceURI === XMLNS_NS) return isDropped(attribute.value);
  return isDropped(attribute.namespaceURI);
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function startsWith(
  bytes: Uint8Array,
  at: number,
  end: number,
  text: string,
): boolean {
  if (at + text.length > end) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The offset after the first `text` at or after `from`, or -1 before `end`. */
function after(
  bytes: Uint8Array,
  from: number,
  end: number,
  text: string,
): number {
  for (let at = from; at + text.length <= end; at++) {
    if (startsWith(bytes, at, end, text)) return at + text.length;
  }
  return -1;
}

/** The offset after a doctype's closing `>`, skipping quoted strings and the internal subset. */
function afterDoctype(bytes: Uint8Array, from: number, end: number): number {
  let depth = 0;
  for (let at = from; at < end; at++) {
    const byte = bytes[at];
    if (byte === 0x22 || byte === 0x27) {
      const close = bytes.indexOf(byte, at + 1);
      if (close < 0 || close >= end) return -1;
      at = close;
    } else if (byte === 0x5b) {
      depth++;
    } else if (byte === 0x5d) {
      depth--;
    } else if (byte === 0x3e && depth <= 0) {
      return at + 1;
    }
  }
  return -1;
}
