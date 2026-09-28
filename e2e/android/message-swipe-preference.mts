import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import {
  SWIPE_PREFERENCE_KEY,
  type SwipePreferenceObservation,
} from './message-swipe-contract.mts';
import type { MaestroDevice } from './maestro-session.mts';

const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml';
const ABSENT_FILE = '__TRINITY_SWIPE_PREFERENCES_ABSENT__';
const ENTRY = /\n?[ \t]*<string name="trinity\.message-swipe">[^<]*<\/string>/gu;

interface ParsedPreferences {
  /** Every top-level entry name, in document order. */
  readonly names: readonly string[];
  readonly swipe: string | null;
}

/** Strictly parse native SharedPreferences; never return or embed raw XML in errors. */
function parsePreferences(xml: string): ParsedPreferences {
  const parser = new SaxesParser({ xmlns: false });
  const stack: SaxesTagPlain[] = [];
  const names: string[] = [];
  let swipe: string | null = null;
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
      const name = String(tag.attributes['name']);
      names.push(name);
      if (name === SWIPE_PREFERENCE_KEY) {
        assert(tag.name === 'string' && swipe === null);
        swipe = '';
      }
    } else {
      assert(parent.name === 'set' && tag.name === 'string' && attributes.length === 0);
    }
    stack.push(tag);
  });
  const readText = (text: string): void => {
    const tag = stack.at(-1);
    if (tag?.name === 'string') {
      if (stack.length === 2 && tag.attributes['name'] === SWIPE_PREFERENCE_KEY) swipe += text;
    } else {
      assert(text.trim() === '');
    }
  };
  parser.on('text', readText);
  parser.on('cdata', readText);
  parser.on('closetag', () => { stack.pop(); });
  try {
    parser.write(xml).close();
  } catch {
    assert.fail('Native swipe Preferences is a complete XML map with no unsupported entity or entry');
  }
  assert.equal(new Set(names).size, names.length, 'Native Preferences names are unique');
  return { names, swipe };
}

export function parseNativeSwipePreference(xml: string): SwipePreferenceObservation {
  const { swipe } = parsePreferences(xml);
  if (swipe === null) return { present: false, value: null, effective: 'off' };
  const value = swipe === 'right' || swipe === 'left' || swipe === 'off' ? swipe : null;
  return { present: true, value, effective: value ?? 'invalid' };
}

/**
 * The same document with exactly the swipe entry replaced (or removed for
 * `null`); every other entry is byte-for-byte unchanged.
 */
export function withSwipePreference(xml: string, seed: 'right' | 'left' | null): string {
  const before = parsePreferences(xml);
  let next = xml.replace(ENTRY, '');
  if (seed !== null) {
    const entry = `    <string name="${SWIPE_PREFERENCE_KEY}">${seed}</string>\n`;
    if (/<map\s*\/>/u.test(next)) next = next.replace(/<map\s*\/>/u, `<map>\n${entry}</map>`);
    else {
      const close = next.lastIndexOf('</map>');
      assert(close >= 0, 'Native Preferences has a closing map');
      const head = next.slice(0, close);
      next = `${head}${head.endsWith('\n') ? '' : '\n'}${entry}${next.slice(close)}`;
    }
  }
  const after = parsePreferences(next);
  assert.deepEqual(after.names.filter((name) => name !== SWIPE_PREFERENCE_KEY),
    before.names.filter((name) => name !== SWIPE_PREFERENCE_KEY),
    'Only the swipe entry changes');
  assert.equal(after.swipe, seed, 'The rewritten document holds exactly the seed');
  return next;
}

const EMPTY_PREFERENCES = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map />\n";

async function readXml(device: MaestroDevice, applicationId: string): Promise<string> {
  const xml = await device.adb(
    'shell',
    `run-as ${applicationId} sh -c 'if [ -f ${PREFERENCE_FILE} ]; then cat ${PREFERENCE_FILE}; else printf %s ${ABSENT_FILE}; fi'`,
  );
  return xml === ABSENT_FILE ? EMPTY_PREFERENCES : xml;
}

/** Observe package-owned Capacitor Preferences without mutating them. */
export async function readNativeSwipePreference(
  device: MaestroDevice,
  applicationId: string,
): Promise<SwipePreferenceObservation> {
  return parseNativeSwipePreference(await readXml(device, applicationId));
}

/**
 * With the application stopped, set exactly `trinity.message-swipe` (or remove
 * it for the predecessor's unseeded Off) and read it back before any launch.
 * The document never reaches an argument, log or error.
 */
export async function seedNativeSwipePreference(
  device: MaestroDevice,
  applicationId: 'eu.qwky.trinity',
  seed: 'right' | 'left' | null,
): Promise<SwipePreferenceObservation> {
  await device.adb('shell', 'am', 'force-stop', applicationId);
  const next = withSwipePreference(await readXml(device, applicationId), seed);
  const directory = await mkdtemp(join(tmpdir(), 'trinity-swipe-preference-'));
  const local = join(directory, 'CapacitorStorage.xml');
  const remote = `/data/local/tmp/trinity-swipe-${randomUUID()}.xml`;
  const failures: unknown[] = [];
  try {
    await writeFile(local, next, { mode: 0o600 });
    await device.adb('push', local, remote);
    await device.adb(
      'shell',
      `run-as ${applicationId} sh -c 'mkdir -p shared_prefs && cat ${remote} > ${PREFERENCE_FILE}.tmp && chmod 600 ${PREFERENCE_FILE}.tmp && mv ${PREFERENCE_FILE}.tmp ${PREFERENCE_FILE}'`,
    );
  } catch (error) {
    failures.push(error);
  }
  try { await device.adb('shell', 'rm', '-f', remote); } catch (error) { failures.push(error); }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Native swipe preference seed failed');
  return readNativeSwipePreference(device, applicationId);
}
