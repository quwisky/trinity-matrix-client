import {
  CONFIG_EXPORT_VERSION,
  type ConfigEntry,
  type ConfigValue,
} from './config-schema';
import { isConfigRecord } from './config-validation';

/** How much of a value is shown in a one-line change summary. */
const MAX_SUMMARY = 60;

/** Import-only aliases for Appearance paths written by portable format version 1. */
const VERSION_ONE_APPEARANCE_PATHS: Readonly<Record<string, string>> = {
  'theme.mode': 'appearance.mode',
  'theme.palette': 'appearance.theme',
  'theme.textScale': 'appearance.textSize',
  'theme.density': 'appearance.density',
  'theme.codeScale': 'appearance.codeSize',
  'theme.codeLineNumbers': 'appearance.codeLinePresentation',
};

/** One setting the document would move, and where it would move it. */
export interface ConfigChange {
  readonly path: string;
  /** What the app holds right now. */
  readonly from: ConfigValue;
  /** What it would hold — the *validated* value, so this is what actually gets stored. */
  readonly to: ConfigValue;
}

/**
 * A document that can be applied: which settings it moves, and anything about it worth
 * saying first.
 *
 * `changes` is the change summary the issue asks for — empty when the document matches the
 * app exactly, which is what makes re-applying an untouched export a no-op rather than a
 * pile of writes.
 */
export interface AcceptedConfigPlan {
  readonly ok: true;
  readonly changes: readonly ConfigChange[];
  readonly warnings: readonly string[];
}

/**
 * A document that will not be applied at all.
 *
 * `problems` names the offending path for each one. Nothing partial is ever written: this
 * variant has no way to reach `AppConfigService.apply`, which takes only the accepted plan —
 * so "reject the whole document rather than write partial state" is enforced by the type,
 * not by remembering to check.
 */
export interface RejectedConfigPlan {
  readonly ok: false;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/** What checking a document produced. Warnings appear on both: they never block. */
export type ConfigApplyPlan = AcceptedConfigPlan | RejectedConfigPlan;

/** One change as a line the UI can list: `theme.palette: "trinity" → "amethyst"`. */
export function describeConfigChange(change: ConfigChange): string {
  return `${change.path}: ${summarise(change.from)} → ${summarise(change.to)}`;
}

/**
 * Check a whole document against the registered settings, and say what applying it would do.
 *
 * Pure, so the rules can be read (and tested) without the DI graph: the entries arrive as a
 * parameter and nothing is written here — `AppConfigService.apply` does that, and only from
 * a plan this returned.
 *
 * The three outcomes, from the issue's requirements:
 *   • a value its owning setting refuses → the **whole document** is rejected, naming the
 *     path, because a half-applied config is worse than none;
 *   • a path this build does not know — a newer export, or a typo → a **warning**, and the
 *     rest still applies (decision 4: warn and proceed, naming what will not apply here);
 *   • a setting absent from the document → left alone, so a hand-written fragment that sets
 *     one preference is a legitimate document.
 */
export function planConfigApply(
  document: unknown,
  entries: readonly ConfigEntry[],
): ConfigApplyPlan {
  if (!isConfigRecord(document)) {
    return rejected([
      'This is not a settings document: expected a JSON object holding a version and a settings block.',
    ]);
  }
  const version = document['version'];
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    // Without a version an older export cannot be told from a damaged file, which is the
    // whole reason the envelope carries one.
    return rejected([
      'This is not a settings document: it has no version number, so it cannot be read as an export.',
    ]);
  }
  const settings = document['settings'];
  if (!isConfigRecord(settings)) {
    return rejected([
      'This is not a settings document: its settings block is missing, or is not a JSON object.',
    ]);
  }

  const warnings: string[] = [];
  if (version > CONFIG_EXPORT_VERSION) {
    warnings.push(
      `This document was written by a newer version of Trinity (format version ${version}; this build reads version ${CONFIG_EXPORT_VERSION}). Settings it added are named below and will not be applied.`,
    );
  }

  const pasted = new Map<string, unknown>();
  const migratedPaths = new Set<string>();
  collect(
    settings,
    '',
    new Set(entries.map((entry) => entry.path)),
    {
      pasted,
      directPaths: new Set<string>(),
      migratedPaths,
      warnings,
    },
    version,
  );
  if (migratedPaths.size > 0) {
    warnings.unshift(
      'Appearance settings from portable format version 1 were migrated to their current paths.',
    );
  }

  const problems: string[] = [];
  const changes: ConfigChange[] = [];
  for (const entry of entries) {
    if (!pasted.has(entry.path)) {
      continue;
    }
    const outcome = entry.validate(pasted.get(entry.path));
    if (!outcome.ok) {
      problems.push(`${entry.path}: ${outcome.problem}`);
      continue;
    }
    if (outcome.warning) {
      warnings.push(`${entry.path}: ${outcome.warning}`);
    }
    const current = entry.read();
    if (!sameValue(current, outcome.value)) {
      changes.push({ path: entry.path, from: current, to: outcome.value });
    }
  }

  return problems.length > 0
    ? { ok: false, problems, warnings }
    : { ok: true, changes, warnings };
}

/**
 * Walk the nested settings down to the paths the registry knows, collecting their values
 * and naming everything else.
 *
 * Stops descending the moment a prefix *is* a registered path, because a setting's own value
 * can be an object — the shortcut overrides and the push gateway both are — and taking it
 * apart would hand its fields to the walker as unknown paths.
 */
function collect(
  node: { readonly [key: string]: unknown },
  prefix: string,
  paths: ReadonlySet<string>,
  out: {
    pasted: Map<string, unknown>;
    directPaths: Set<string>;
    migratedPaths: Set<string>;
    warnings: string[];
  },
  version: number,
): void {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (paths.has(path)) {
      out.pasted.set(path, value);
      out.directPaths.add(path);
      continue;
    }
    const migratedPath =
      version === 1 ? VERSION_ONE_APPEARANCE_PATHS[path] : undefined;
    if (migratedPath && paths.has(migratedPath)) {
      if (!out.directPaths.has(migratedPath)) {
        out.pasted.set(migratedPath, value);
      }
      out.migratedPaths.add(migratedPath);
      continue;
    }
    if (isConfigRecord(value)) {
      collect(value, path, paths, out, version);
      continue;
    }
    out.warnings.push(
      `${path} is not a setting this version of Trinity has, so it will not be applied.`,
    );
  }
}

function rejected(problems: readonly string[]): RejectedConfigPlan {
  return { ok: false, problems, warnings: [] };
}

/**
 * Structural equality, so an unchanged setting produces no change.
 *
 * Compared field by field rather than by `JSON.stringify`, which would call two equal
 * objects different because their keys were written in another order — every re-import of a
 * hand-edited document would then rewrite settings it did not touch.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (!isConfigRecord(a) || !isConfigRecord(b)) {
    return false;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]),
  );
}

/** A value as one short line, for the change summary. */
function summarise(value: ConfigValue): string {
  const text = JSON.stringify(value) ?? 'nothing';
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}
