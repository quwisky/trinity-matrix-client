import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map } from 'rxjs';
import {
  planConfigApply,
  type AcceptedConfigPlan,
  type ConfigApplyPlan,
  type ConfigChange,
} from './config-plan';
import {
  APP_CONFIG_ENTRIES,
  CONFIG_EXPORT_VERSION,
  type ConfigDocument,
  type ConfigEntry,
  type ConfigSettings,
  type ConfigValue,
} from './config-schema';

/** A tree node while it is being built; handed back as the readonly {@link ConfigSettings}. */
type ConfigTreeNode = { [key: string]: ConfigValue };

/** How many spaces the exported JSON is indented with — part of what people paste around. */
const INDENT = 2;

/**
 * Reads the whole local preference layer as one document, applies an edited one back, and
 * puts it all to defaults.
 *
 * Every direction goes through {@link ConfigEntry}, never through `Preferences`: reads come
 * from the owning services' signals, so the document always matches what the app is actually
 * rendering, and writes go through their setters, so the running app follows immediately.
 *
 * Applying is two steps on purpose — {@link validate} produces a plan naming what would
 * change, {@link apply} takes only a plan that came back clean — so nothing is ever written
 * from a document that was not checked whole.
 *
 * Scope is exactly the registered entries. Anything not registered — drafts, the account
 * registry, the push applied-id ledger, per-account space ordering — is invisible here, so
 * {@link resetToDefaults} cannot destroy it. See `config-schema.ts` for the ledger of every
 * key and why each is in or out.
 */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  /**
   * Every registered setting, sorted by path so the document's key order is stable across
   * launches — a diff between two exports should show what changed, not what was injected
   * in which order. Optional, like `ENCRYPTION_DIALOG_COMPONENTS`: with no app wiring
   * (a lib-in-isolation test) the registry is simply empty.
   */
  readonly entries: readonly ConfigEntry[] = flatten(
    inject(APP_CONFIG_ENTRIES, { optional: true }) ?? [],
  );

  /**
   * The current settings, nested by path. Reads the owning services' signals, so wrapping
   * it in a `computed()` keeps the rendered document live as preferences change — the
   * template reads that signal rather than calling this.
   *
   * Every path is guaranteed collision-free by {@link flatten}, so a leaf can never be
   * overwritten by a branch built for a longer path.
   */
  settings(): ConfigSettings {
    const root: ConfigTreeNode = {};
    const nodes = new Map<string, ConfigTreeNode>();
    for (const entry of this.entries) {
      const segments = entry.path.split('.');
      const leaf = segments[segments.length - 1];
      let node = root;
      let prefix = '';
      for (let depth = 0; depth < segments.length - 1; depth++) {
        const segment = segments[depth];
        prefix = prefix ? `${prefix}.${segment}` : segment;
        let child = nodes.get(prefix);
        if (!child) {
          child = {};
          nodes.set(prefix, child);
          node[segment] = child;
        }
        node = child;
      }
      node[leaf] = entry.read();
    }
    return root;
  }

  /** The settings wrapped in the versioned envelope, stamped with the time of the read. */
  export(): ConfigDocument {
    return {
      version: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      settings: this.settings(),
    };
  }

  /** {@link export} pretty-printed — what Copy puts on the clipboard and a file holds. */
  exportJson(): string {
    return JSON.stringify(this.export(), null, INDENT);
  }

  /**
   * Check a pasted or imported document, and say what applying it would do — which settings
   * move and to what, plus anything worth saying first.
   *
   * Nothing is written here. A rejected plan cannot be applied at all (see {@link apply}),
   * so a bad value anywhere takes the whole document down rather than leaving the app in a
   * state that was never in anyone's file.
   */
  validate(document: unknown): ConfigApplyPlan {
    return planConfigApply(document, this.entries);
  }

  /**
   * {@link validate} straight from the text in the editor.
   *
   * A syntax error comes back as an ordinary rejected plan rather than an exception, so the
   * one surface that reports problems reports all of them.
   */
  validateJson(json: string): ConfigApplyPlan {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unreadable';
      return {
        ok: false,
        problems: [`This is not valid JSON: ${detail}`],
        warnings: [],
      };
    }
    return this.validate(parsed);
  }

  /**
   * Apply a checked document, through the owning services' setters, so the running app
   * follows without a reload.
   *
   * Takes only an accepted plan — a rejected one is a different type and cannot be passed —
   * and writes only the settings that actually differ, so re-applying an unmodified export
   * touches nothing.
   *
   * Sequential rather than concurrent: two entries can share one stored blob (the GIF
   * provider and its key do), and each of those setters rewrites the blob from the other's
   * current value, so overlapping them would let one write drop the other.
   *
   * Cold, like every other one-shot action here: nothing happens until it is subscribed.
   */
  apply(plan: AcceptedConfigPlan): Observable<void> {
    return defer(() => from(this.writeAll(plan.changes))).pipe(
      map(() => undefined),
    );
  }

  private async writeAll(changes: readonly ConfigChange[]): Promise<void> {
    const byPath = new Map(this.entries.map((entry) => [entry.path, entry]));
    for (const change of changes) {
      const entry = byPath.get(change.path);
      if (entry) {
        await entry.write(change.to);
      }
    }
  }

  /**
   * Restore every exported setting to its documented default, through the owning services'
   * setters, so the app follows without a reload.
   *
   * Cold, like every other one-shot action here: nothing happens until it is subscribed.
   * Completes once every reset that persists asynchronously has settled.
   */
  resetToDefaults(): Observable<void> {
    return defer(() =>
      from(
        Promise.all(this.entries.map(async (entry) => await entry.reset())),
      ).pipe(map(() => undefined)),
    );
  }
}

/** One flat list from the per-library contributions, sorted by path. */
function flatten(
  groups: readonly (readonly ConfigEntry[])[],
): readonly ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      entries.push(entry);
    }
  }
  assertDistinctPaths(entries);
  // Code point order, not `localeCompare`: the key order of a *committed* document must not
  // depend on the device's locale or on which ICU version the runtime shipped with, or two
  // exports of identical settings could differ by machine.
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/**
 * Fail the registry build when two entries claim overlapping paths.
 *
 * Two ways to collide, both of which silently drop a setting from the document rather than
 * erroring: the same path twice (the second `read()` wins), and one path being a *prefix* of
 * another (`push.gateway` beside a future `push.gateway.url` — whichever is written first is
 * overwritten, the string leaf by the branch or the branch by the leaf). A dropped setting is
 * invisible in the export and, once apply lands, would be written to the wrong owner.
 *
 * Checked against the whole registry rather than one library's entries, which is where a
 * per-lib uniqueness assertion cannot help: the paths that collide come from different libs.
 * Prefixes are tested explicitly rather than inferred from sort order — a `-` sorts below
 * `.`, so `push.gateway-x` can land between `push.gateway` and `push.gateway.url` and split
 * a colliding pair that a neighbour-only pass would then miss.
 */
function assertDistinctPaths(entries: readonly ConfigEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new Error(
        `Two config entries claim the path '${entry.path}'. Each exported setting needs its own path.`,
      );
    }
    paths.add(entry.path);
  }
  for (const path of paths) {
    const segments = path.split('.');
    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('.');
      if (paths.has(prefix)) {
        throw new Error(
          `The config entry path '${prefix}' is a prefix of '${path}'. One would overwrite the other in the exported document; give them sibling paths instead.`,
        );
      }
    }
  }
}
