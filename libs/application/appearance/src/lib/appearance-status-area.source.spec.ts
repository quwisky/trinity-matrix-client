import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserAppearanceStatusAreaSource,
  type StatusAreaReading,
} from './appearance-status-area.source';

interface Layer {
  readonly element: HTMLElement;
  readonly background: string;
  readonly borderTop?: { readonly width: string; readonly color: string };
}

// jsdom has no hit testing, cascade or canvas: stub exactly those, top layer first.
function stubPage(options: {
  coarse?: boolean;
  layers: Layer[];
  pixel?: [number, number, number, number];
  envInset?: string;
}) {
  const fills: string[] = [];
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) => ({ matches: options.coarse ?? true, media: query }) as never,
  );
  document.elementsFromPoint = vi.fn(() =>
    options.layers.map((l) => l.element),
  );
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const layer = options.layers.find((l) => l.element === element);
    return {
      backgroundColor: layer?.background ?? 'rgba(0, 0, 0, 0)',
      borderTopWidth: layer?.borderTop?.width ?? '0px',
      borderTopColor: layer?.borderTop?.color ?? 'rgb(0, 0, 0)',
      paddingTop: options.envInset ?? '0px',
    } as unknown as CSSStyleDeclaration;
  });
  let fillStyle = '';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    set fillStyle(value: string) {
      fillStyle = value;
    },
    get fillStyle() {
      return fillStyle;
    },
    fillRect: () => fills.push(fillStyle),
    getImageData: () => ({
      data: Uint8ClampedArray.from(options.pixel ?? [21, 22, 24, 255]),
    }),
  } as never);
  return fills;
}

function layer(
  background: string,
  borderTop?: Layer['borderTop'],
  top = 0,
): Layer {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ top }) as DOMRect;
  return { element, background, borderTop };
}

function collect(source: BrowserAppearanceStatusAreaSource) {
  const readings: StatusAreaReading[] = [];
  const subscription = source.observe().subscribe((r) => readings.push(r));
  return { readings, subscription };
}

describe('BrowserAppearanceStatusAreaSource', () => {
  const elementsFromPoint = document.elementsFromPoint;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.elementsFromPoint = elementsFromPoint;
    document.body.replaceChildren();
  });

  it('samples at once, bottom layer first, with a top border over its own background', () => {
    const fills = stubPage({
      layers: [
        layer('rgba(0, 0, 0, 0)', {
          width: '54px',
          color: 'oklch(21% 0.015 265deg)',
        }),
        layer('oklch(18% 0.014 265deg)'),
      ],
    });
    const { readings, subscription } = collect(
      TestBed.inject(BrowserAppearanceStatusAreaSource),
    );

    expect(readings).toEqual([
      { kind: 'page', color: '#151618', underStatusBar: false },
    ]);
    expect(fills).toEqual([
      'oklch(18% 0.014 265deg)',
      'rgba(0, 0, 0, 0)',
      'oklch(21% 0.015 265deg)',
    ]);
    subscription.unsubscribe();
  });

  it('ignores a top border that starts below the point', () => {
    const fills = stubPage({
      layers: [layer('rgb(1, 2, 3)', { width: '4px', color: 'red' }, 10)],
    });
    collect(
      TestBed.inject(BrowserAppearanceStatusAreaSource),
    ).subscription.unsubscribe();
    expect(fills).toEqual(['rgb(1, 2, 3)']);
  });

  it('reads nothing it could not composite to an opaque colour', () => {
    stubPage({ layers: [layer('rgba(0, 0, 0, 0)')], pixel: [0, 0, 0, 0] });
    const { readings, subscription } = collect(
      TestBed.inject(BrowserAppearanceStatusAreaSource),
    );
    expect(readings).toEqual([{ kind: 'unknown' }]);
    subscription.unsubscribe();
  });

  it('says whether the page reaches under the status bar', () => {
    // Android WebView before 140: SystemBars pads the WebView and `env()` reads 0.
    stubPage({ layers: [layer('rgb(21, 22, 24)')], envInset: '0px' });
    let { readings, subscription } = collect(
      TestBed.inject(BrowserAppearanceStatusAreaSource),
    );
    expect(readings).toEqual([
      { kind: 'page', color: '#151618', underStatusBar: false },
    ]);
    subscription.unsubscribe();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();

    stubPage({ layers: [layer('rgb(21, 22, 24)')], envInset: '54px' });
    ({ readings, subscription } = collect(
      TestBed.inject(BrowserAppearanceStatusAreaSource),
    ));
    expect(readings).toEqual([
      { kind: 'page', color: '#151618', underStatusBar: true },
    ]);
    subscription.unsubscribe();
  });

  it('stays idle without a touch screen or an installed web app', () => {
    const fills = stubPage({ coarse: false, layers: [layer('rgb(1, 2, 3)')] });
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { readings, subscription } = collect(
      TestBed.inject(BrowserAppearanceStatusAreaSource),
    );
    expect(readings).toEqual([{ kind: 'unknown' }]);
    expect(fills).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('samples again after a change settles and lets go of everything on unsubscribe', async () => {
    const pixel: [number, number, number, number] = [21, 22, 24, 255];
    stubPage({ layers: [layer('rgb(21, 22, 24)')], pixel });
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const removed = vi.spyOn(window, 'removeEventListener');
    const { readings, subscription } = collect(
      TestBed.inject(BrowserAppearanceStatusAreaSource),
    );

    pixel.splice(0, 3, 127, 143, 241);
    document.body.append(document.createElement('trn-banner'));
    await vi.advanceTimersByTimeAsync(99);
    expect(readings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readings.at(-1)).toEqual({
      kind: 'page',
      color: '#7f8ff1',
      underStatusBar: false,
    });

    subscription.unsubscribe();
    expect(disconnect).toHaveBeenCalled();
    expect(removed.mock.calls.map(([type]) => type)).toEqual([
      'animationend',
      'resize',
    ]);
  });
});
