/**
 * electron-builder configuration, chosen by release channel. Packaging scripts and the
 * release workflow pass `--config` with this file. A plain X.Y.Z version in
 * electron/package.json packages electron-builder.yml as written; X.Y.Z-next.N merges
 * electron-builder.next.yml on top ("Trinity Next", installs beside stable). A bare
 * `electron-builder` run reads only electron-builder.yml, so it always packages stable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Configuration } from 'electron-builder';
import { parse } from 'yaml';
import { releaseChannel, type ReleaseChannel } from './src/release-channel';

type ConfigObject = Record<string, unknown>;

const isObject = (value: unknown): value is ConfigObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Objects merge key by key; lists and values replace. Unlike electron-builder's `extends`,
 * which appends lists, an override can never keep a stable entry such as the stable scheme.
 */
export function mergeConfig(
  base: ConfigObject,
  overrides: ConfigObject,
): ConfigObject {
  const merged: ConfigObject = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] =
      isObject(current) && isObject(value)
        ? mergeConfig(current, value)
        : value;
  }
  return merged;
}

function readYaml(file: string): ConfigObject {
  const value: unknown = parse(
    readFileSync(join(import.meta.dirname, file), 'utf8'),
  );
  if (!isObject(value)) throw new Error(`${file} is not a mapping.`);
  return value;
}

/** The configuration to package `version` with; throws for a version outside both channels. */
export function builderConfigFor(version: string): {
  readonly channel: ReleaseChannel;
  readonly config: Configuration;
} {
  const channel = releaseChannel(version);
  const base = readYaml('electron-builder.yml');
  const config =
    channel === 'next'
      ? mergeConfig(base, readYaml('electron-builder.next.yml'))
      : base;
  return { channel, config: config as Configuration };
}

function shellVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'),
  );
  const version = isObject(manifest) ? manifest['version'] : undefined;
  if (typeof version !== 'string') {
    throw new Error('electron/package.json has no version.');
  }
  return version;
}

export default builderConfigFor(shellVersion()).config;
