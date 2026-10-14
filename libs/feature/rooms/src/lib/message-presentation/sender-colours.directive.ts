import {
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from '@angular/core';
import { RootThemeObserver } from './root-theme';
import {
  decideColours,
  parseCssColour,
  parseHexColour,
  toHex,
  type Rgb,
} from './sender-colours';

/** What a body's sender colours are drawn on and inherit, resolved to sRGB. */
export interface MessageTheme {
  readonly text: Rgb;
  readonly surface: Rgb;
}

const TOKEN_SELECTOR = '[class*="mx-fg-"], [class*="mx-bg-"]';

/** Never coloured: code keeps its syntax colours and a mention its pill. */
const UNCOLOURED = 'pre, code, a.mention';

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
 * The body's message surface and text colour. The surface is `--trinity-message-surface`, set by
 * a container whose background is not the canvas (the composer preview, edit history); timeline
 * and thread bodies leave it unset and get `--trinity-surface-canvas`. Transient tints (hover,
 * the jump flash, selection) are deliberately ignored. Null when either cannot be resolved, and
 * then no sender colour is applied.
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
  const text = surface && resolveColour(style.color, doc);
  return surface && text ? { surface, text } : null;
}

/**
 * Paint the body's sender colours, parents first, keeping each that stays readable. Resets every
 * token element first, so a theme change re-decides from scratch. Linear in the number of token
 * elements; the ancestor walk is bounded by the 100-level nesting cap.
 */
export function applySenderColours(
  host: HTMLElement,
  theme: MessageTheme | null,
): void {
  const effective = new Map<
    Element,
    { readonly text: Rgb; readonly background: Rgb }
  >();
  for (const element of host.querySelectorAll<HTMLElement>(TOKEN_SELECTOR)) {
    element.style.removeProperty('color');
    element.style.removeProperty('background-color');
    // A concealed spoiler is drawn by its stylesheet: an inline colour on the spoiler itself
    // would beat `color: transparent` and show what it hides. Its children are coloured and
    // hidden with it.
    if (
      !theme ||
      element.classList.contains('mx-spoiler') ||
      element.closest(UNCOLOURED)
    ) {
      continue;
    }
    const context = contextOf(element, host, effective) ?? {
      text: theme.text,
      background: theme.surface,
    };
    const fg = tokenColour(element, 'mx-fg-');
    const bg = tokenColour(element, 'mx-bg-');
    const kept = decideColours({ fg, bg }, context.text, context.background);
    if (kept.fg && fg) element.style.color = toHex(fg);
    if (kept.bg && bg) element.style.backgroundColor = toHex(bg);
    effective.set(element, {
      text: kept.fg && fg ? fg : context.text,
      background: kept.bg && bg ? bg : context.background,
    });
  }
}

/** The nearest coloured ancestor's effective colours, skipping ancestors that were not painted. */
function contextOf(
  element: Element,
  host: HTMLElement,
  effective: ReadonlyMap<
    Element,
    { readonly text: Rgb; readonly background: Rgb }
  >,
): { readonly text: Rgb; readonly background: Rgb } | undefined {
  for (
    let ancestor = element.parentElement?.closest(TOKEN_SELECTOR);
    ancestor && host.contains(ancestor);
    ancestor = ancestor.parentElement?.closest(TOKEN_SELECTOR)
  ) {
    const context = effective.get(ancestor);
    if (context) return context;
  }
  return undefined;
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
