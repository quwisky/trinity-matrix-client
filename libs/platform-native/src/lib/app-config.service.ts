import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map } from 'rxjs';
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
 * Reads the whole local preference layer as one document, and puts it back to defaults.
 *
 * Both directions go through {@link ConfigEntry}, never through `Preferences`: reads come
 * from the owning services' signals, so the document always matches what the app is actually
 * rendering, and resets go through their setters, so the running app follows immediately.
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
   * The current settings, nested by path. Reads signals, so calling this from a template
   * method keeps the rendered document live as preferences change.
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
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
