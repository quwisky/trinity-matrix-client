import assert from 'node:assert/strict';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const DENSITY_KEY = 'trinity.appearance.density';
const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml';
const ABSENT_FILE = '__TRINITY_DENSITY_PREFERENCES_ABSENT__';

export interface NativeAppearanceDensityObservation {
  readonly present: boolean;
  readonly version: 1 | null;
  readonly value: 'cosy' | 'compact';
}

function readDensityXmlEntry(xml: string): string | null {
  const parser = new SaxesParser({ xmlns: false });
  const stack: SaxesTagPlain[] = [];
  let density: string | null = null;

  parser.on('doctype', () => assert.fail());
  parser.on('opentag', (tag) => {
    const parent = stack.at(-1);
    const attributes = Object.keys(tag.attributes);
    if (!parent) {
      assert(tag.name === 'map' && attributes.length === 0);
    } else if (parent.name === 'map') {
      const textOrSet = tag.name === 'string' || tag.name === 'set';
      assert(textOrSet || ['boolean', 'int', 'long', 'float'].includes(tag.name));
      assert(Object.hasOwn(tag.attributes, 'name'));
      assert(textOrSet
        ? attributes.length === 1
        : attributes.length === 2 && Object.hasOwn(tag.attributes, 'value'));
      if (tag.attributes['name'] === DENSITY_KEY) {
        assert(tag.name === 'string' && density === null);
        density = '';
      }
    } else {
      assert(parent.name === 'set' && tag.name === 'string' && attributes.length === 0);
    }
    stack.push(tag);
  });
  const readText = (text: string): void => {
    const tag = stack.at(-1);
    if (tag?.name === 'string') {
      if (stack.length === 2 && tag.attributes['name'] === DENSITY_KEY)
        density += text;
    } else {
      assert(text.trim() === '');
    }
  };
  parser.on('text', readText);
  parser.on('cdata', readText);
  parser.on('closetag', () => { stack.pop(); });
  try {
    // Saxes checks the entire document, decodes entities once, and ignores
    // comments. Reject DTDs; only native SharedPreferences structure is accepted.
    parser.write(xml).close();
  } catch {
    // Parser diagnostics can contain unrelated Preferences values or XML names.
    assert.fail('Native density Preferences is a complete XML map with no unsupported XML entity or malformed entry');
  }
  return density;
}

/** Decode only the density entry; never return or embed raw XML in errors. */
export function parseNativeAppearanceDensityPreference(
  xml: string,
): NativeAppearanceDensityObservation {
  const decoded = readDensityXmlEntry(xml);
  if (decoded === null) {
    return { present: false, version: null, value: 'cosy' };
  }

  let stored: unknown;
  try {
    stored = JSON.parse(decoded) as unknown;
  } catch {
    assert.fail('Native density Preferences has a JSON envelope');
  }
  assert(stored !== null && typeof stored === 'object' && !Array.isArray(stored),
    'Native density Preferences envelope is an object');
  const envelope = stored as Record<string, unknown>;
  assert(Object.keys(envelope).length === 2 &&
    Object.hasOwn(envelope, 'version') && Object.hasOwn(envelope, 'value'),
  'Native density Preferences envelope has exact keys');
  assert(envelope['version'] === 1,
    'Native density Preferences envelope is version 1');
  assert(envelope['value'] === 'cosy' || envelope['value'] === 'compact',
    'Native density Preferences value is Cosy or Compact');
  return { present: true, version: 1, value: envelope['value'] };
}

/** Observe package-owned Capacitor Preferences without mutating them. */
export async function readNativeAppearanceDensityPreference(
  client: AccountWorkspaceClient,
  expected: 'cosy' | 'compact',
  timeoutMs = 15_000,
): Promise<NativeAppearanceDensityObservation> {
  return waitForNativeShellState(
    async () => {
      const xml = await client.device.adb(
        'shell',
        `run-as ${client.applicationId} sh -c 'if [ -f ${PREFERENCE_FILE} ]; then cat ${PREFERENCE_FILE}; else printf %s ${ABSENT_FILE}; fi'`,
      );
      return parseNativeAppearanceDensityPreference(
        xml === ABSENT_FILE ? '<map/>' : xml,
      );
    },
    (value) => value.value === expected &&
      (expected === 'cosy' || value.present),
    `native ${DENSITY_KEY}=${expected}`,
    client.signal,
    timeoutMs,
  );
}
