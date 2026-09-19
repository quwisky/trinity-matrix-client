import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml';
export const AA_NORMAL_TEXT = 4.5;

export interface Srgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface ClearAllDataSnapshot {
  readonly preferenceKeys: readonly string[];
  readonly databases: readonly string[];
  readonly documentTimeOrigin: number;
}

export interface ClearAllDataVisualObservation {
  readonly applied: {
    readonly dark: boolean;
    readonly theme: string | null;
  };
  readonly media: {
    readonly hoverNone: boolean;
    readonly coarsePointer: boolean;
  };
  readonly danger: Srgb;
  readonly text: Srgb;
  readonly background: Srgb;
  readonly ratio: number;
  readonly layers: readonly string[];
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function parseNativePreferenceKeys(xml: string): readonly string[] {
  return [
    ...xml.matchAll(
      /<(?:string|set|int|long|float|boolean)\s+name="([^"]+)"/gu,
    ),
  ]
    .map((match) => decodeXmlAttribute(match[1]!))
    .sort();
}

async function nativePreferenceKeys(
  client: AccountWorkspaceClient,
): Promise<readonly string[]> {
  const xml = await client.device.adb(
    'shell',
    `run-as ${APPLICATION_ID} cat ${PREFERENCE_FILE} 2>/dev/null || true`,
  );
  return parseNativePreferenceKeys(xml);
}

async function rendererSnapshot(
  client: AccountWorkspaceClient,
): Promise<{
  readonly databases: readonly string[];
  readonly documentTimeOrigin: number;
}> {
  const value = await evaluateNative(
    client.webview,
    `(async()=>{
      if(typeof indexedDB.databases!=='function')throw new Error('IndexedDB enumeration is unavailable');
      return {databases:(await indexedDB.databases()).map(database=>database.name).filter(name=>typeof name==='string'&&name.length>0).sort(),documentTimeOrigin:performance.timeOrigin};
    })()`,
  );
  assert(
    value &&
      typeof value === 'object' &&
      'databases' in value &&
      Array.isArray(value.databases) &&
      value.databases.every((name: unknown) => typeof name === 'string') &&
      'documentTimeOrigin' in value &&
      typeof value.documentTimeOrigin === 'number',
    'Renderer storage snapshot is valid',
  );
  return value as {
    readonly databases: readonly string[];
    readonly documentTimeOrigin: number;
  };
}

export async function snapshot(
  client: AccountWorkspaceClient,
): Promise<ClearAllDataSnapshot> {
  const [preferenceKeys, renderer] = await Promise.all([
    nativePreferenceKeys(client),
    rendererSnapshot(client),
  ]);
  return { preferenceKeys, ...renderer };
}

/** Seed setup state through the same native Capacitor Preferences bridge as the app. */
export async function seedPreference(
  client: AccountWorkspaceClient,
  preferenceKey: string,
  value: string,
): Promise<void> {
  const seeded = await evaluateNative(
    client.webview,
    `(async()=>{
      const preferences=window.Capacitor?.Plugins?.Preferences;
      if(!preferences)throw new Error('Capacitor Preferences plugin is unavailable');
      const preferenceKey=${JSON.stringify(preferenceKey)},value=${JSON.stringify(value)};
      await preferences.set({ key: preferenceKey, value });
      return true;
    })()`,
  );
  assert.equal(seeded, true, `Seeded native preference ${preferenceKey}`);
}

export async function waitForRestartedEmptyState(
  client: AccountWorkspaceClient,
  previousDatabases: readonly string[],
  previousTimeOrigin: number,
  timeoutMs = 30_000,
): Promise<ClearAllDataSnapshot> {
  const observed = await waitForNativeShellState(
    () => snapshot(client),
    (value) =>
      value.documentTimeOrigin !== previousTimeOrigin &&
      value.preferenceKeys.length === 0 &&
      previousDatabases.every((name) => !value.databases.includes(name)),
    'fresh document with empty native preferences and removed databases',
    client.signal,
    timeoutMs,
  );
  assert(observed, 'Clear-all-data restart observation completed');
  return observed;
}

function luminance({ r, g, b }: Srgb): number {
  const channel = (component: number): number => {
    const value = component / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(left: Srgb, right: Srgb): number {
  const [high, low] = [luminance(left), luminance(right)].sort(
    (a, b) => b - a,
  );
  return (high + 0.05) / (low + 0.05);
}

/** Observe the real installed-WebView rest state without invoking product behavior. */
export async function observeVisual(
  client: AccountWorkspaceClient,
): Promise<ClearAllDataVisualObservation> {
  const value = await evaluateNative(
    client.webview,
    `(()=>{
      const element=document.querySelector('[data-testid="clear-all-data"]');
      if(!(element instanceof HTMLElement))throw new Error('Clear-all-data control is unavailable');
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      if(rect.width<=0||rect.height<=0||style.visibility!=='visible')throw new Error('Clear-all-data control is not visible');
      const canvas=document.createElement('canvas');
      canvas.width=canvas.height=1;
      const context=canvas.getContext('2d', { willReadFrequently: true });
      if(!context)throw new Error('Contrast canvas is unavailable');
      const paint=colour=>{
        const sentinel='#010203';
        context.fillStyle=sentinel;
        context.fillStyle=colour;
        if(context.fillStyle===sentinel&&colour.trim()!==sentinel)throw new Error('Browser rejected colour: '+colour);
        context.fillRect(0,0,1,1);
      };
      const pixel=()=>{const [r,g,b,a]=context.getImageData(0,0,1,1).data;return {r,g,b,a}};
      const opaque=colour=>{context.clearRect(0,0,1,1);paint(colour);return pixel().a===255};
      const token=style.getPropertyValue('--trinity-danger').trim();
      if(!token)throw new Error('Danger token is unavailable');
      context.clearRect(0,0,1,1);paint(token);const dangerPixel=pixel();
      const stack=[];let node=element,base=null;
      while(node){const background=getComputedStyle(node).backgroundColor;if(opaque(background)){base=background;break}stack.unshift(background);node=node.parentElement}
      if(base===null)throw new Error('No opaque ancestor background');
      const layers=[base,...stack];context.clearRect(0,0,1,1);for(const layer of layers)paint(layer);
      const backgroundPixel=pixel();paint(style.color);const textPixel=pixel();
      return {
        applied:{dark:document.documentElement.classList.contains('dark'),theme:document.documentElement.getAttribute('data-theme')},
        media:{hoverNone:matchMedia('(hover: none)').matches,coarsePointer:matchMedia('(pointer: coarse)').matches},
        danger:{r:dangerPixel.r,g:dangerPixel.g,b:dangerPixel.b},
        text:{r:textPixel.r,g:textPixel.g,b:textPixel.b},
        background:{r:backgroundPixel.r,g:backgroundPixel.g,b:backgroundPixel.b},
        layers
      };
    })()`,
  );
  assert(value && typeof value === 'object', 'Visual observation is an object');
  const observation = value as Omit<ClearAllDataVisualObservation, 'ratio'>;
  assert(
    observation.applied &&
      typeof observation.applied.dark === 'boolean' &&
      (observation.applied.theme === null ||
        typeof observation.applied.theme === 'string'),
    'Applied theme observation is valid',
  );
  assert(
    observation.media &&
      typeof observation.media.hoverNone === 'boolean' &&
      typeof observation.media.coarsePointer === 'boolean',
    'Android media observation is valid',
  );
  for (const colour of [
    observation.danger,
    observation.text,
    observation.background,
  ]) {
    assert(
      colour &&
        [colour.r, colour.g, colour.b].every(
          (component) => Number.isInteger(component) && component >= 0 && component <= 255,
        ),
      'Observed colour is opaque sRGB',
    );
  }
  assert(
    Array.isArray(observation.layers) &&
      observation.layers.every((layer) => typeof layer === 'string'),
    'Contrast layers are strings',
  );
  return {
    ...observation,
    ratio: contrastRatio(observation.text, observation.background),
  };
}
