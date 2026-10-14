import {
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from '@angular/core';
import { RootThemeObserver } from './root-theme';
import {
  MIN_SENDER_CONTRAST,
  contrastRatio,
  decideColours,
  parseCssColour,
  parseHexColour,
  toHex,
  type Rgb,
} from './sender-colours';

/**
 * What a body's sender colours are drawn on and inherit, resolved to sRGB: the message surface
 * and text colour, the colour links keep inside a sender colour, and the rail a table header
 * is drawn on.
 */
export interface MessageTheme {
  readonly text: Rgb;
  readonly surface: Rgb;
  readonly link: Rgb;
  readonly rail: Rgb;
}

/** The colours a sender colour is checked against at one place in the body. */
interface Context {
  readonly text: Rgb;
  readonly background: Rgb;
}

const TOKEN_SELECTOR = '[class*="mx-fg-"], [class*="mx-bg-"]';

/** Never coloured: code keeps its syntax colours and a mention its pill. */
const UNCOLOURED = 'pre, code, a.mention';

/** A link sets its own text colour (`--trinity-link`); a mention is a pill and never coloured. */
const LINK = 'a:not(.mention)';

/** A table header draws its own background (`--trinity-rail`) under inherited text. */
const HEADER = 'th';

/** Elements that change the context below them: a link's text, a table header's background. */
const BOUNDARY = `${LINK}, ${HEADER}`;

/** Surface and text colours are a handful of theme values; resolve each one once. */
const resolved = new Map<string, Rgb | null>();

/** Far above the themes' surface and text values; a bound, not a working size. */
const MAX_RESOLVED = 64;

/**
 * Applies the sender colours `sanitizeMatrixHtml` carried as `mx-fg-*`/`mx-bg-*` tokens, keeping
 * only those that reach 3:1 against what they are drawn on in the current theme (owner decision
 * 2). Reads computed style once per body in `earlyRead`, writes through the CSSOM in `write`,
 * and re-runs for every mounted body when {@link RootThemeObserver} reports a theme change.
 * Bodies without a token cost a substring test.
 */
@Directive({ selector: '[trnSenderColours]' })
export class SenderColoursDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly theme = inject(RootThemeObserver);

  readonly source = input('', { alias: 'trnSenderColours' });

  constructor() {
    afterRenderEffect({
      earlyRead: () => {
        const source = this.source();
        this.theme.key();
        return hasColourTokens(source)
          ? readMessageTheme(this.host.nativeElement)
          : undefined;
      },
      write: (theme) => {
        const resolvedTheme = theme();
        if (resolvedTheme !== undefined) {
          applySenderColours(this.host.nativeElement, resolvedTheme);
        }
      },
    });
  }
}

function hasColourTokens(source: string): boolean {
  return source.includes('mx-fg-') || source.includes('mx-bg-');
}

/**
 * The body's message surface, text, link and table-header colours, from one computed style. The
 * surface is `--trinity-message-surface`, set by every container a body is drawn in (the timeline
 * and thread panes, the composer preview, edit history); `--trinity-surface-canvas` is only the
 * fallback. Transient tints (hover, the jump flash, selection) are deliberately ignored. Null when
 * any cannot be resolved, and then no sender colour is applied.
 */
export function readMessageTheme(host: HTMLElement): MessageTheme | null {
  const doc = host.ownerDocument;
  const style = doc.defaultView?.getComputedStyle(host);
  if (!style) return null;
  const surface = resolveColour(
    style.getPropertyValue('--trinity-message-surface') ||
      style.getPropertyValue('--trinity-surface-canvas'),
    doc,
  );
  if (!surface) return null;
  const text = resolveColour(style.color, doc);
  const link = resolveColour(style.getPropertyValue('--trinity-link'), doc);
  const rail = resolveColour(style.getPropertyValue('--trinity-rail'), doc);
  return text && link && rail ? { surface, text, link, rail } : null;
}

/**
 * Paint the body's sender colours, parents first, keeping each that stays readable. Resets every
 * token element first, so a theme change re-decides from scratch. A kept background that holds a
 * link must suit the link colour too, and a kept text colour that holds a table header must read
 * on its rail. Linear in the size of the body: each ancestor walk is bounded by the 100-level
 * nesting cap, and the walk up from links and headers stops at a marked ancestor.
 */
export function applySenderColours(
  host: HTMLElement,
  theme: MessageTheme | null,
): void {
  const aroundLinks = theme ? ancestorsOf(host, LINK) : new Set<Element>();
  const aroundHeaders = theme ? ancestorsOf(host, HEADER) : new Set<Element>();
  const effective = new Map<Element, Context>();
  for (const element of host.querySelectorAll<HTMLElement>(TOKEN_SELECTOR)) {
    element.style.removeProperty('color');
    element.style.removeProperty('background-color');
    // A concealed spoiler is drawn by its stylesheet: an inline colour on the spoiler itself
    // would beat `color: transparent` and show what it hides. Its children are coloured and
    // hidden with it.
    if (
      !theme ||
      element.classList.contains('mx-spoiler') ||
      isUncoloured(element, host)
    ) {
      continue;
    }
    const context = contextOf(element, host, theme, effective);
    const requested = tokenColour(element, 'mx-fg-');
    const bg = tokenColour(element, 'mx-bg-');
    // A table header inside inherits the text colour onto its own rail, so it must read there too.
    const fg =
      requested &&
      aroundHeaders.has(element) &&
      contrastRatio(requested, theme.rail) < MIN_SENDER_CONTRAST
        ? null
        : requested;
    let kept = decideColours({ fg, bg }, context.text, context.background);
    if (
      kept.bg &&
      bg &&
      aroundLinks.has(element) &&
      contrastRatio(theme.link, bg) < MIN_SENDER_CONTRAST
    ) {
      // A link inside keeps its own colour, which this background would hide: drop it and
      // decide the text colour as if no background had been asked for.
      kept = decideColours({ fg, bg: null }, context.text, context.background);
    }
    if (kept.fg && fg) element.style.color = toHex(fg);
    if (kept.bg && bg) element.style.backgroundColor = toHex(bg);
    effective.set(element, {
      text: kept.fg && fg ? fg : context.text,
      background: kept.bg && bg ? bg : context.background,
    });
  }
}

/** Inside code, `pre` or a mention pill within this body. */
function isUncoloured(element: Element, host: HTMLElement): boolean {
  const owner = element.closest(UNCOLOURED);
  return owner !== null && host.contains(owner);
}

/** Every element in the body that holds an element matching `selector`. */
function ancestorsOf(
  host: HTMLElement,
  selector: string,
): ReadonlySet<Element> {
  const marked = new Set<Element>();
  for (const match of host.querySelectorAll(selector)) {
    // A marked ancestor's own ancestors are marked already.
    for (
      let ancestor = match.parentElement;
      ancestor && ancestor !== host && !marked.has(ancestor);
      ancestor = ancestor.parentElement
    ) {
      marked.add(ancestor);
    }
  }
  return marked;
}

/**
 * What an element is drawn on and inherits: the nearest decided ancestor's colours (or the
 * theme's), changed by any link (its text colour) or table header (the rail) in between.
 */
function contextOf(
  element: Element,
  host: HTMLElement,
  theme: MessageTheme,
  effective: ReadonlyMap<Element, Context>,
): Context {
  let context: Context = { text: theme.text, background: theme.surface };
  const boundaries: Element[] = [];
  for (
    let ancestor = element.parentElement;
    ancestor && ancestor !== host;
    ancestor = ancestor.parentElement
  ) {
    const decided = effective.get(ancestor);
    if (decided) {
      context = decided;
      break;
    }
    if (ancestor.matches(BOUNDARY)) boundaries.push(ancestor);
  }
  // Outermost first, so the innermost boundary has the last word.
  for (const boundary of boundaries.reverse()) {
    context = boundary.matches(HEADER)
      ? { text: context.text, background: theme.rail }
      : { text: theme.link, background: context.background };
  }
  return context;
}

function tokenColour(
  element: Element,
  prefix: 'mx-fg-' | 'mx-bg-',
): Rgb | null {
  for (const token of element.classList) {
    if (token.startsWith(prefix))
      return parseHexColour(token.slice(prefix.length));
  }
  return null;
}

/** A CSS colour as sRGB: parsed when it is a known form, else through a 1×1 canvas. */
function resolveColour(value: string, doc: Document): Rgb | null {
  const key = value.trim();
  if (!key) return null;
  if (!resolved.has(key)) {
    if (resolved.size >= MAX_RESOLVED) resolved.clear();
    resolved.set(key, parseCssColour(key) ?? canvasColour(key, doc));
  }
  return resolved.get(key) ?? null;
}

/**
 * Let the browser parse a colour form the helper does not know (e.g. `color(srgb …)`). A
 * see-through colour stays unresolved: what shows through it is not known here, so no sender
 * colour is measured against it.
 */
function canvasColour(value: string, doc: Document): Rgb | null {
  const context = doc
    .createElement('canvas')
    .getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const sentinel = '#010203';
  context.fillStyle = sentinel;
  context.fillStyle = value;
  // An unparseable value leaves fillStyle unchanged.
  if (context.fillStyle === sentinel) return null;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
  return alpha === 255 ? { r, g, b } : null;
}
