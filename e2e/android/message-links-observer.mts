import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

/*
 * Read-only renderer observations for the installed-Android Matrix-link suite.
 *
 * Every builder returns one pure expression string. It reads the DOM, computed
 * style, geometry and window metrics only: no click, focus, key, scroll, class,
 * style, attribute or location write. Window-level values are reached through
 * `document.defaultView`, so a guard can execute the same text in jsdom with only
 * `document` in scope. The contrast expression paints a detached 1x1 canvas that
 * is never attached to the document.
 */

const OBSERVATION_TIMEOUT_MS = 15_000;
const STABLE_INTERVAL_MS = 250;
const STABLE_TIMEOUT_MS = 10_000;

export interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Srgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type AppearanceModeId = 'system' | 'light' | 'dark';

export interface ObservationOptions<T> {
  /** Poll until this accepts the parsed observation; the default takes the first read. */
  readonly accepts?: (value: T) => boolean;
  readonly description?: string;
  /** Finite polling bound; defaults to 15 s. */
  readonly timeoutMs?: number;
}

export interface RoomLinkPreviewObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly hostCount: number;
  readonly hostClasses: readonly string[];
  readonly name: string | null;
  readonly topic: string | null;
  readonly address: string | null;
  readonly primary: {
    readonly count: number;
    /** Primary buttons anywhere in the document, not only inside the one preview. */
    readonly documentCount: number;
    readonly visible: boolean;
    readonly text: string | null;
    readonly ariaDisabled: string | null;
    readonly disabled: boolean;
    readonly focused: boolean;
  };
  readonly success: { readonly count: number; readonly visible: boolean; readonly text: string | null };
  readonly actionError: { readonly count: number; readonly visible: boolean; readonly text: string | null };
  readonly loadError: {
    readonly count: number;
    readonly visible: boolean;
    readonly title: string | null;
    readonly message: string | null;
    readonly retryCount: number;
  };
  readonly unavailable: string | null;
  readonly retryCount: number;
}

export interface ComposerPlaceholderObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly placeholder: string | null;
  readonly href: string;
}

export interface LinkAnchorObservation {
  readonly text: string;
  readonly href: string | null;
  readonly className: string;
  readonly rect: CssRect;
  readonly visible: boolean;
  readonly unobstructedCenter: boolean;
}

export interface LinkAnchorsObservation {
  readonly label: string;
  readonly anchors: readonly LinkAnchorObservation[];
}

export interface AppliedModeObservation {
  readonly htmlDark: boolean;
  readonly theme: string | null;
  readonly density: string | null;
  readonly codeLines: string | null;
  readonly inlineFontSize: string;
  readonly codeScale: string;
  readonly modes: readonly {
    readonly mode: AppearanceModeId;
    readonly count: number;
    readonly checked: boolean;
    readonly disabled: boolean;
  }[];
  readonly checkedMode: AppearanceModeId | null;
  readonly checkedCount: number;
  readonly pathname: string;
  readonly href: string;
}

export interface SuccessContrastObservation {
  readonly text: string;
  readonly foreground: Srgb;
  readonly background: Srgb;
  readonly layers: readonly string[];
  readonly htmlDark: boolean;
  /** The checked Appearance radio; null when Settings is not rendered. */
  readonly checkedMode: AppearanceModeId | null;
}

export type HitResult = 'self' | 'descendant' | 'other' | 'none';

export interface PortraitSheetGeometry {
  readonly previewCount: number;
  /* Replica of predecessor lines 472-491. */
  readonly portrait: boolean;
  readonly surface: { readonly left: number; readonly right: number; readonly bottom: number };
  readonly footer: { readonly top: number; readonly bottom: number };
  readonly viewportBottom: number;
  readonly viewportWidth: number;
  /* Applied metrics and physical-reach inputs. */
  readonly applied: {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly devicePixelRatio: number;
    readonly visualViewport: { readonly offsetTop: number; readonly height: number } | null;
  };
  readonly rects: {
    readonly section: CssRect;
    readonly footer: CssRect;
    readonly primary: CssRect | null;
    readonly close: CssRect | null;
  };
  readonly primaryCount: number;
  readonly closeCount: number;
  readonly primaryHit: HitResult;
  readonly closeHit: HitResult;
  readonly footerPaddingBottom: string;
}

export interface UserCardDialogEntry {
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly ariaModal: string | null;
  readonly visible: boolean;
  readonly containsCard: boolean;
  readonly containsName: boolean;
  readonly cardName: string | null;
  readonly inGlobalWrapper: boolean;
  readonly inConnectedBox: boolean;
}

export interface UserCardDialogObservation {
  readonly dialogCount: number;
  readonly dialogs: readonly UserCardDialogEntry[];
  readonly userCardCount: number;
  readonly globalWrapperCount: number;
  readonly darkBackdropCount: number;
  readonly visibleDarkBackdropCount: number;
  readonly transparentBackdropCount: number;
  readonly connectedBoxCount: number;
  readonly coarsePointer: boolean;
  readonly platform: string | null;
}

export interface NavigationMarker {
  readonly href: string;
  readonly timeOrigin: number;
  readonly historyLength: number;
}

export interface AppliedProfileObservation {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly visualViewport: { readonly offsetTop: number; readonly height: number } | null;
  readonly coarsePointer: boolean;
  readonly maxTouchPoints: number;
  readonly platform: string | null;
  readonly orientationPortrait: boolean;
}

/* Shared read-only prelude: window access, visibility, whitespace-normalized text. */
const PRELUDE = `
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        view.getComputedStyle(element).visibility === 'visible';
    };
    const norm = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const rectOf = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };`;

const CHECKED_MODE = `
    const modeIds = ['system', 'light', 'dark'];
    const modes = modeIds.map((mode) => {
      const inputs = [...document.querySelectorAll('[data-testid="mode-' + mode + '"] input')];
      return { mode, count: inputs.length,
        checked: inputs.length === 1 && inputs[0].matches(':checked'),
        disabled: inputs.length === 1 && inputs[0].matches(':disabled') };
    });
    const checked = modes.filter((mode) => mode.checked);
    const checkedMode = checked.length === 1 ? checked[0].mode : null;`;

export function previewExpression(): string {
  return `(() => {${PRELUDE}
    const sections = [...document.querySelectorAll('[data-testid="room-link-preview"]')];
    const hosts = [...document.querySelectorAll('trn-room-link-preview')];
    const section = sections.length === 1 ? sections[0] : null;
    const one = (selector) => section ? [...section.querySelectorAll(selector)] : [];
    const text = (selector) => { const found = one(selector); return found.length === 1 ? norm(found[0].textContent) : null; };
    const notice = (selector) => { const found = one(selector);
      return { count: found.length, visible: found.length === 1 && visible(found[0]),
        text: found.length === 1 ? norm(found[0].textContent) : null }; };
    const primaries = one('[data-testid="room-link-primary"]');
    const primary = primaries.length === 1 ? primaries[0] : null;
    const loadErrors = one('[data-testid="room-link-load-error"]');
    const loadError = loadErrors.length === 1 ? loadErrors[0] : null;
    const retries = (root) => root ? [...root.querySelectorAll('button')]
      .filter((button) => norm(button.textContent) === 'Retry').length : 0;
    const titles = loadError ? [...loadError.querySelectorAll('h3')] : [];
    const messages = loadError ? [...loadError.querySelectorAll('p')] : [];
    return {
      count: sections.length,
      visible: !!section && visible(section),
      hostCount: hosts.length,
      hostClasses: hosts.length === 1 ? norm(hosts[0].getAttribute('class')).split(' ').filter(Boolean) : [],
      name: text('[data-testid="room-link-name"]'),
      topic: text('[data-testid="room-link-topic"]'),
      address: text('[data-testid="room-link-address"]'),
      primary: {
        count: primaries.length,
        documentCount: document.querySelectorAll('[data-testid="room-link-primary"]').length,
        visible: !!primary && visible(primary),
        text: primary ? norm(primary.textContent) : null,
        ariaDisabled: primary ? primary.getAttribute('aria-disabled') : null,
        disabled: !!primary && primary.matches(':disabled'),
        focused: !!primary && document.activeElement === primary,
      },
      success: notice('[data-testid="room-link-success"]'),
      actionError: notice('[data-testid="room-link-action-error"]'),
      loadError: {
        count: loadErrors.length,
        visible: !!loadError && visible(loadError),
        title: titles.length === 1 ? norm(titles[0].textContent) : null,
        message: messages.length === 1 ? norm(messages[0].textContent) : null,
        retryCount: retries(loadError),
      },
      unavailable: text('[data-testid="room-link-unavailable"]'),
      retryCount: retries(section),
    };
  })()`;
}

export function composerPlaceholderExpression(): string {
  return `(() => {${PRELUDE}
    const inputs = [...document.querySelectorAll('[data-testid="composer-input"]')];
    const input = inputs.length === 1 ? inputs[0] : null;
    return {
      count: inputs.length,
      visible: !!input && visible(input),
      placeholder: input ? input.getAttribute('placeholder') : null,
      href: view.location.href,
    };
  })()`;
}

export function linkAnchorsExpression(label: string): string {
  return `(() => {${PRELUDE}
    const label = ${JSON.stringify(label)};
    const anchors = [...document.querySelectorAll('.scroll a')]
      .filter((anchor) => anchor.textContent?.trim() === label);
    return {
      label,
      anchors: anchors.map((anchor) => {
        const rect = rectOf(anchor);
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        const hit = x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight
          ? document.elementFromPoint(x, y) : null;
        return {
          text: anchor.textContent?.trim() ?? '',
          href: anchor.getAttribute('href'),
          className: anchor.getAttribute('class') ?? '',
          rect,
          visible: visible(anchor),
          unobstructedCenter: !!hit && anchor.contains(hit),
        };
      }),
    };
  })()`;
}

export function appliedModeExpression(): string {
  return `(() => {${PRELUDE}${CHECKED_MODE}
    const root = document.documentElement;
    const inline = root.style;
    return {
      htmlDark: root.matches('.dark'),
      theme: root.getAttribute('data-theme'),
      density: root.getAttribute('data-density'),
      codeLines: root.getAttribute('data-code-lines'),
      inlineFontSize: inline.getPropertyValue('font-size'),
      codeScale: inline.getPropertyValue('--trinity-code-scale'),
      modes,
      checkedMode,
      checkedCount: checked.length,
      pathname: view.location.pathname,
      href: view.location.href,
    };
  })()`;
}

/** Port of `clear-all-data-observer.mts` colour resolution, keyed on the success notice. */
export function successContrastExpression(): string {
  return `(() => {${PRELUDE}${CHECKED_MODE}
    const elements = [...document.querySelectorAll('[data-testid="room-link-success"]')];
    if (elements.length !== 1) throw new Error('Expected one room-link success notice, found ' + elements.length);
    const element = elements[0];
    if (!visible(element)) throw new Error('Room-link success notice is not visible');
    const style = view.getComputedStyle(element);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Contrast canvas is unavailable');
    const paint = (colour) => {
      const sentinel = '#010203';
      context.fillStyle = sentinel;
      context.fillStyle = colour;
      if (context.fillStyle === sentinel && colour.trim() !== sentinel) throw new Error('Browser rejected colour: ' + colour);
      context.fillRect(0, 0, 1, 1);
    };
    const pixel = () => { const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data; return { r, g, b, a }; };
    const opaque = (colour) => { context.clearRect(0, 0, 1, 1); paint(colour); return pixel().a === 255; };
    const stack = [];
    let node = element, base = null;
    while (node) {
      const background = view.getComputedStyle(node).backgroundColor;
      if (opaque(background)) { base = background; break; }
      stack.unshift(background);
      node = node.parentElement;
    }
    if (base === null) throw new Error('No opaque ancestor background');
    const layers = [base, ...stack];
    context.clearRect(0, 0, 1, 1);
    for (const layer of layers) paint(layer);
    const backgroundPixel = pixel();
    paint(style.color);
    const textPixel = pixel();
    return {
      text: norm(element.textContent),
      foreground: { r: textPixel.r, g: textPixel.g, b: textPixel.b },
      background: { r: backgroundPixel.r, g: backgroundPixel.g, b: backgroundPixel.b },
      layers,
      htmlDark: document.documentElement.matches('.dark'),
      checkedMode,
    };
  })()`;
}

/** Replica of predecessor lines 472-491, plus applied metrics and reach inputs. */
export function portraitGeometryExpression(): string {
  return `(() => {${PRELUDE}
    const previews = [...document.querySelectorAll('[data-testid="room-link-preview"]')];
    if (previews.length !== 1) throw new Error('Expected one room-link preview, found ' + previews.length);
    const element = previews[0];
    const footerElement = element.querySelector('.room-preview__actions');
    if (!footerElement) throw new Error('Room-link preview footer is unavailable');
    const surface = element.getBoundingClientRect();
    const footer = footerElement.getBoundingClientRect();
    const viewport = view.visualViewport;
    const viewportBottom =
      (viewport?.offsetTop ?? 0) + (viewport?.height ?? view.innerHeight);
    const primaries = [...element.querySelectorAll('[data-testid="room-link-primary"]')];
    const closes = [...footerElement.querySelectorAll('button')]
      .filter((button) => button.textContent?.trim() === 'Close');
    const hitOf = (target) => {
      if (!target) return 'none';
      const rect = target.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return !hit ? 'none' : hit === target ? 'self' : target.contains(hit) ? 'descendant' : 'other';
    };
    const primary = primaries.length === 1 ? primaries[0] : null;
    const close = closes.length === 1 ? closes[0] : null;
    return {
      previewCount: previews.length,
      portrait: view.innerHeight > view.innerWidth,
      surface: {
        left: surface.left,
        right: surface.right,
        bottom: surface.bottom,
      },
      footer: { top: footer.top, bottom: footer.bottom },
      viewportBottom,
      viewportWidth: view.innerWidth,
      applied: {
        innerWidth: view.innerWidth,
        innerHeight: view.innerHeight,
        devicePixelRatio: view.devicePixelRatio,
        visualViewport: viewport ? { offsetTop: viewport.offsetTop, height: viewport.height } : null,
      },
      rects: {
        section: rectOf(element),
        footer: rectOf(footerElement),
        primary: primary ? rectOf(primary) : null,
        close: close ? rectOf(close) : null,
      },
      primaryCount: primaries.length,
      closeCount: closes.length,
      primaryHit: hitOf(primary),
      closeHit: hitOf(close),
      footerPaddingBottom: view.getComputedStyle(footerElement).paddingBottom,
    };
  })()`;
}

export function userCardDialogExpression(name: string): string {
  return `(() => {${PRELUDE}
    const name = ${JSON.stringify(name)};
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const darkBackdrops = [...document.querySelectorAll('.cdk-overlay-dark-backdrop')];
    return {
      dialogCount: dialogs.length,
      dialogs: dialogs.map((dialog) => {
        const cards = [...dialog.querySelectorAll('[data-testid="user-card-name"]')];
        return {
          role: dialog.getAttribute('role'),
          ariaLabel: dialog.getAttribute('aria-label'),
          ariaModal: dialog.getAttribute('aria-modal'),
          visible: visible(dialog),
          containsCard: dialog.querySelectorAll('[data-testid="user-card"]').length === 1,
          containsName: norm(dialog.textContent).includes(name),
          cardName: cards.length === 1 ? norm(cards[0].textContent) : null,
          inGlobalWrapper: !!dialog.closest('.cdk-global-overlay-wrapper'),
          inConnectedBox: !!dialog.closest('.cdk-overlay-connected-position-bounding-box'),
        };
      }),
      userCardCount: document.querySelectorAll('[data-testid="user-card"]').length,
      globalWrapperCount: document.querySelectorAll('.cdk-global-overlay-wrapper').length,
      darkBackdropCount: darkBackdrops.length,
      visibleDarkBackdropCount: darkBackdrops.filter(visible).length,
      transparentBackdropCount: document.querySelectorAll('.cdk-overlay-transparent-backdrop').length,
      connectedBoxCount: document.querySelectorAll('.cdk-overlay-connected-position-bounding-box').length,
      coarsePointer: view.matchMedia('(pointer: coarse)').matches,
      platform: typeof view.Capacitor?.getPlatform === 'function' ? view.Capacitor.getPlatform() : null,
    };
  })()`;
}

export function navigationMarkerExpression(): string {
  return `(() => {
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    return {
      href: view.location.href,
      timeOrigin: view.performance.timeOrigin,
      historyLength: view.history.length,
    };
  })()`;
}

export function appliedProfileExpression(): string {
  return `(() => {
    const view = document.defaultView;
    if (!view) throw new Error('Document has no window');
    const viewport = view.visualViewport;
    return {
      innerWidth: view.innerWidth,
      innerHeight: view.innerHeight,
      devicePixelRatio: view.devicePixelRatio,
      visualViewport: viewport ? { offsetTop: viewport.offsetTop, height: viewport.height } : null,
      coarsePointer: view.matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: view.navigator.maxTouchPoints,
      platform: typeof view.Capacitor?.getPlatform === 'function' ? view.Capacitor.getPlatform() : null,
      orientationPortrait: view.matchMedia('(orientation: portrait)').matches,
    };
  })()`;
}

function object(value: unknown, description: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${description} is an object`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, description: string): void {
  assert(typeof value === 'number' && Number.isFinite(value), `${description} is finite`);
}

function count(value: unknown, description: string): void {
  assert(Number.isInteger(value) && (value as number) >= 0, `${description} is a count`);
}

function boolean(value: unknown, description: string): void {
  assert.equal(typeof value, 'boolean', `${description} is boolean`);
}

function nullableString(value: unknown, description: string): void {
  assert(value === null || typeof value === 'string', `${description} is a string or null`);
}

function string(value: unknown, description: string): void {
  assert.equal(typeof value, 'string', `${description} is a string`);
}

function rect(value: unknown, description: string): void {
  const result = object(value, description);
  for (const field of ['x', 'y', 'width', 'height', 'right', 'bottom'])
    finite(result[field], `${description} ${field}`);
}

function srgb(value: unknown, description: string): void {
  const result = object(value, description);
  assert(['r', 'g', 'b'].every((channel) =>
    Number.isInteger(result[channel]) &&
    (result[channel] as number) >= 0 && (result[channel] as number) <= 255),
  `${description} is opaque sRGB`);
}

function mode(value: unknown, description: string): void {
  assert(value === null || value === 'system' || value === 'light' || value === 'dark',
    `${description} is an Appearance mode or null`);
}

function visualViewport(value: unknown, description: string): void {
  if (value === null) return;
  const result = object(value, description);
  finite(result['offsetTop'], `${description} offsetTop`);
  finite(result['height'], `${description} height`);
}

function notice(value: unknown, description: string): void {
  const result = object(value, description);
  count(result['count'], `${description} count`);
  boolean(result['visible'], `${description} visibility`);
  nullableString(result['text'], `${description} text`);
}

function parsePreview(value: unknown): RoomLinkPreviewObservation {
  const result = object(value, 'Room-link preview observation');
  count(result['count'], 'Preview count');
  boolean(result['visible'], 'Preview visibility');
  count(result['hostCount'], 'Preview host count');
  assert(Array.isArray(result['hostClasses']) &&
    result['hostClasses'].every((name: unknown) => typeof name === 'string'),
  'Preview host classes are strings');
  for (const field of ['name', 'topic', 'address', 'unavailable'])
    nullableString(result[field], `Preview ${field}`);
  const primary = object(result['primary'], 'Preview primary');
  count(primary['count'], 'Primary count');
  for (const field of ['visible', 'disabled', 'focused'])
    boolean(primary[field], `Primary ${field}`);
  nullableString(primary['text'], 'Primary text');
  nullableString(primary['ariaDisabled'], 'Primary aria-disabled');
  notice(result['success'], 'Success notice');
  notice(result['actionError'], 'Action error');
  const loadError = object(result['loadError'], 'Load error');
  count(loadError['count'], 'Load error count');
  boolean(loadError['visible'], 'Load error visibility');
  nullableString(loadError['title'], 'Load error title');
  nullableString(loadError['message'], 'Load error message');
  count(loadError['retryCount'], 'Load error Retry count');
  count(result['retryCount'], 'Preview Retry count');
  return result as unknown as RoomLinkPreviewObservation;
}

function parseComposerPlaceholder(value: unknown): ComposerPlaceholderObservation {
  const result = object(value, 'Composer placeholder observation');
  count(result['count'], 'Composer count');
  boolean(result['visible'], 'Composer visibility');
  nullableString(result['placeholder'], 'Composer placeholder');
  string(result['href'], 'Composer document href');
  return result as unknown as ComposerPlaceholderObservation;
}

function parseLinkAnchors(value: unknown, label: string): LinkAnchorsObservation {
  const result = object(value, 'Link anchor observation');
  assert.equal(result['label'], label, 'Link anchor observation label');
  assert(Array.isArray(result['anchors']), 'Link anchors are an array');
  for (const entry of result['anchors']) {
    const anchor = object(entry, 'Link anchor');
    string(anchor['text'], 'Link anchor text');
    nullableString(anchor['href'], 'Link anchor href');
    string(anchor['className'], 'Link anchor class');
    rect(anchor['rect'], 'Link anchor rect');
    boolean(anchor['visible'], 'Link anchor visibility');
    boolean(anchor['unobstructedCenter'], 'Link anchor unobstructed centre');
  }
  return result as unknown as LinkAnchorsObservation;
}

function parseModes(result: Record<string, unknown>): void {
  assert(Array.isArray(result['modes']) && result['modes'].length === 3,
    'Appearance mode controls are listed');
  for (const entry of result['modes']) {
    const control = object(entry, 'Appearance mode control');
    mode(control['mode'], 'Appearance mode control id');
    count(control['count'], 'Appearance mode input count');
    boolean(control['checked'], 'Appearance mode checked');
    boolean(control['disabled'], 'Appearance mode disabled');
  }
  mode(result['checkedMode'], 'Checked Appearance mode');
  count(result['checkedCount'], 'Checked Appearance mode count');
}

function parseAppliedMode(value: unknown): AppliedModeObservation {
  const result = object(value, 'Applied Appearance observation');
  boolean(result['htmlDark'], 'Root dark class');
  for (const field of ['theme', 'density', 'codeLines'])
    nullableString(result[field], `Root ${field}`);
  for (const field of ['inlineFontSize', 'codeScale', 'pathname', 'href'])
    string(result[field], `Root ${field}`);
  parseModes(result);
  return result as unknown as AppliedModeObservation;
}

function parseSuccessContrast(value: unknown): SuccessContrastObservation {
  const result = object(value, 'Success contrast observation');
  string(result['text'], 'Success text');
  srgb(result['foreground'], 'Success foreground');
  srgb(result['background'], 'Success background');
  assert(Array.isArray(result['layers']) && result['layers'].length > 0 &&
    result['layers'].every((layer: unknown) => typeof layer === 'string'),
  'Contrast layers are strings');
  boolean(result['htmlDark'], 'Root dark class');
  mode(result['checkedMode'], 'Checked Appearance mode');
  return result as unknown as SuccessContrastObservation;
}

function hit(value: unknown, description: string): void {
  assert(value === 'self' || value === 'descendant' || value === 'other' || value === 'none',
    `${description} is a hit result`);
}

function parsePortraitGeometry(value: unknown): PortraitSheetGeometry {
  const result = object(value, 'Portrait sheet geometry');
  count(result['previewCount'], 'Preview count');
  boolean(result['portrait'], 'Portrait orientation');
  const surface = object(result['surface'], 'Sheet surface');
  for (const field of ['left', 'right', 'bottom']) finite(surface[field], `Surface ${field}`);
  const footer = object(result['footer'], 'Sheet footer');
  for (const field of ['top', 'bottom']) finite(footer[field], `Footer ${field}`);
  finite(result['viewportBottom'], 'Viewport bottom');
  finite(result['viewportWidth'], 'Viewport width');
  const applied = object(result['applied'], 'Applied metrics');
  for (const field of ['innerWidth', 'innerHeight', 'devicePixelRatio'])
    finite(applied[field], `Applied ${field}`);
  visualViewport(applied['visualViewport'], 'Applied visual viewport');
  const rects = object(result['rects'], 'Sheet rects');
  rect(rects['section'], 'Section rect');
  rect(rects['footer'], 'Footer rect');
  for (const field of ['primary', 'close'])
    if (rects[field] !== null) rect(rects[field], `${field} rect`);
  count(result['primaryCount'], 'Primary count');
  count(result['closeCount'], 'Footer Close count');
  hit(result['primaryHit'], 'Primary centre');
  hit(result['closeHit'], 'Footer Close centre');
  string(result['footerPaddingBottom'], 'Footer padding-bottom');
  return result as unknown as PortraitSheetGeometry;
}

function parseUserCardDialog(value: unknown): UserCardDialogObservation {
  const result = object(value, 'User-card dialog observation');
  count(result['dialogCount'], 'Dialog count');
  assert(Array.isArray(result['dialogs']) &&
    result['dialogs'].length === result['dialogCount'], 'Dialog entries match the count');
  for (const entry of result['dialogs']) {
    const dialog = object(entry, 'Dialog entry');
    for (const field of ['role', 'ariaLabel', 'ariaModal', 'cardName'])
      nullableString(dialog[field], `Dialog ${field}`);
    for (const field of ['visible', 'containsCard', 'containsName', 'inGlobalWrapper', 'inConnectedBox'])
      boolean(dialog[field], `Dialog ${field}`);
  }
  for (const field of ['userCardCount', 'globalWrapperCount', 'darkBackdropCount',
    'visibleDarkBackdropCount', 'transparentBackdropCount', 'connectedBoxCount'])
    count(result[field], field);
  boolean(result['coarsePointer'], 'Coarse pointer');
  nullableString(result['platform'], 'Capacitor platform');
  return result as unknown as UserCardDialogObservation;
}

function parseNavigationMarker(value: unknown): NavigationMarker {
  const result = object(value, 'Navigation marker');
  string(result['href'], 'Marker href');
  finite(result['timeOrigin'], 'Marker timeOrigin');
  count(result['historyLength'], 'Marker history length');
  return result as unknown as NavigationMarker;
}

function parseAppliedProfile(value: unknown): AppliedProfileObservation {
  const result = object(value, 'Applied profile');
  for (const field of ['innerWidth', 'innerHeight', 'devicePixelRatio'])
    finite(result[field], `Applied ${field}`);
  visualViewport(result['visualViewport'], 'Applied visual viewport');
  boolean(result['coarsePointer'], 'Coarse pointer');
  count(result['maxTouchPoints'], 'Max touch points');
  nullableString(result['platform'], 'Capacitor platform');
  boolean(result['orientationPortrait'], 'Portrait orientation media');
  return result as unknown as AppliedProfileObservation;
}

/** Evaluate one read-only expression, parse it and poll within a finite bound. */
async function observe<T>(
  client: AccountWorkspaceClient,
  expression: string,
  parse: (value: unknown) => T,
  description: string,
  options: ObservationOptions<T>,
): Promise<T> {
  return waitForNativeShellState(
    async () => parse(await evaluateNative(client.webview, expression)),
    options.accepts ?? (() => true),
    options.description ?? description,
    client.signal,
    options.timeoutMs ?? OBSERVATION_TIMEOUT_MS,
  );
}

export async function readRoomLinkPreview(
  client: AccountWorkspaceClient,
  options: ObservationOptions<RoomLinkPreviewObservation> = {},
): Promise<RoomLinkPreviewObservation> {
  return observe(client, previewExpression(), parsePreview,
    'room-link preview observation', options);
}

export async function readComposerPlaceholder(
  client: AccountWorkspaceClient,
  options: ObservationOptions<ComposerPlaceholderObservation> = {},
): Promise<ComposerPlaceholderObservation> {
  return observe(client, composerPlaceholderExpression(), parseComposerPlaceholder,
    'composer placeholder observation', options);
}

export async function readLinkAnchors(
  client: AccountWorkspaceClient,
  label: string,
  options: ObservationOptions<LinkAnchorsObservation> = {},
): Promise<LinkAnchorsObservation> {
  return observe(client, linkAnchorsExpression(label),
    (value) => parseLinkAnchors(value, label), 'message link anchors', options);
}

export async function readAppliedMode(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedModeObservation> = {},
): Promise<AppliedModeObservation> {
  return observe(client, appliedModeExpression(), parseAppliedMode,
    'applied Appearance mode', options);
}

/** Resolve rendered colours only; the ratio is computed in Node by the contract. */
export async function readSuccessContrast(
  client: AccountWorkspaceClient,
  options: ObservationOptions<SuccessContrastObservation> = {},
): Promise<SuccessContrastObservation> {
  return observe(client, successContrastExpression(), parseSuccessContrast,
    'room-link success contrast', options);
}

export async function readPortraitSheetGeometry(
  client: AccountWorkspaceClient,
  options: ObservationOptions<PortraitSheetGeometry> = {},
): Promise<PortraitSheetGeometry> {
  return observe(client, portraitGeometryExpression(), parsePortraitGeometry,
    'portrait room-link sheet geometry', options);
}

export async function readUserCardDialogModel(
  client: AccountWorkspaceClient,
  name: string,
  options: ObservationOptions<UserCardDialogObservation> = {},
): Promise<UserCardDialogObservation> {
  return observe(client, userCardDialogExpression(name), parseUserCardDialog,
    'user-card dialog model', options);
}

export async function readNavigationMarker(
  client: AccountWorkspaceClient,
  options: ObservationOptions<NavigationMarker> = {},
): Promise<NavigationMarker> {
  return observe(client, navigationMarkerExpression(), parseNavigationMarker,
    'navigation marker', options);
}

export async function readAppliedProfile(
  client: AccountWorkspaceClient,
  options: ObservationOptions<AppliedProfileObservation> = {},
): Promise<AppliedProfileObservation> {
  return observe(client, appliedProfileExpression(), parseAppliedProfile,
    'applied viewport profile', options);
}

/**
 * Read until two consecutive samples, `intervalMs` apart, are identical.
 *
 * The total bound is `timeoutMs` plus at most one read's own bound. An unstable
 * observation fails closed; it is never averaged or retried past the deadline.
 */
export async function stableSample<T>(
  read: () => Promise<T>,
  options: {
    readonly intervalMs?: number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly description?: string;
  } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? STABLE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? STABLE_TIMEOUT_MS;
  const description = options.description ?? 'observation';
  assert(Number.isFinite(intervalMs) && intervalMs > 0 &&
    Number.isFinite(timeoutMs) && timeoutMs >= intervalMs,
  'Stable sampling has a positive interval within a finite bound');
  const deadline = Date.now() + timeoutMs;
  options.signal?.throwIfAborted();
  let previous = JSON.stringify(await read());
  let samples = 1;
  while (Date.now() + intervalMs <= deadline) {
    await delay(intervalMs, undefined, { signal: options.signal });
    const value = await read();
    const current = JSON.stringify(value);
    samples++;
    if (current === previous) return value;
    previous = current;
  }
  throw new Error(
    `Timed out waiting for two identical ${description} samples ${intervalMs} ms apart ` +
      `within ${timeoutMs} ms (${samples} samples)`,
  );
}
