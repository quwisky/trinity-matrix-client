import { Injectable, inject, signal } from '@angular/core';
import {
  Observable,
  ReplaySubject,
  Subscription,
  catchError,
  concatMap,
  defer,
  from,
  isObservable,
  map,
  of,
  race,
  tap,
  timer,
  toArray,
} from 'rxjs';
import {
  planConfigApply,
  type AcceptedConfigPlan,
  type ConfigApplyPlan,
} from './config-plan';
import {
  APP_CONFIG_ENTRIES,
  CONFIG_EXPORT_VERSION,
  CONFIG_RESET_OBSERVATION_BUDGET_MS,
  type ConfigAction,
  type ConfigDocument,
  type ConfigEntry,
  type ConfigResetEntryOutcome,
  type ConfigResetLedger,
  type ConfigResetOutcome,
  type ConfigSettings,
  type ConfigValue,
} from './config-entry';

type ConfigTreeNode = { [key: string]: ConfigValue };

interface OwnedConfigResetAttempt {
  readonly id: number;
  readonly completion: ReplaySubject<ConfigResetOutcome>;
  readonly owner: Subscription;
}

/** Indent of the exported JSON; people paste it around, so keep it stable. */
const INDENT = 2;

/**
 * Reads the whole local preference layer as one document, applies an edited one back, and
 * puts it all to defaults.
 *
 * Every direction goes through {@link ConfigEntry}, never through `Preferences`: reads
 * come from the owning services' signals and writes go through their setters, so the
 * document matches what the app renders and the running app follows immediately.
 *
 * Applying is two steps: {@link validate} produces a plan, and {@link apply} takes only a
 * clean one, so nothing is written from a document that was not checked whole.
 *
 * Scope is exactly the registered entries. Anything unregistered (drafts, the account
 * registry, the push applied-id ledger, per-account space ordering) is invisible here, so
 * {@link resetToDefaults} cannot destroy it. See `config-schema.ts` for the ledger of
 * every key.
 */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  private readonly resetState = signal<ConfigResetLedger | null>(null);
  private activeReset: OwnedConfigResetAttempt | null = null;
  private resetAttempt = 0;

  /**
   * Every registered setting, sorted by path so the document's key order is stable across
   * launches. The registry is empty when the app provides no entries (a lib-in-isolation
   * test).
   */
  readonly entries: readonly ConfigEntry[] = flatten(
    inject(APP_CONFIG_ENTRIES, { optional: true }) ?? [],
  );

  /** Latest value-free reset progress; entry identities are portable catalogue paths. */
  readonly resetLedger = this.resetState.asReadonly();

  /**
   * The current settings, nested by path. Reads the owning services' signals, so a
   * `computed()` around it stays live as preferences change.
   *
   * {@link flatten} guarantees collision-free paths, so a leaf is never overwritten by a
   * branch built for a longer path.
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

  /** {@link export} pretty-printed. */
  exportJson(): string {
    return JSON.stringify(this.export(), null, INDENT);
  }

  /**
   * Check a pasted or imported document and say what applying it would change.
   *
   * Nothing is written here. A rejected plan cannot be applied (see {@link apply}), so a
   * bad value anywhere rejects the whole document instead of leaving the app in a state
   * that was never in anyone's file.
   */
  validate(document: unknown): ConfigApplyPlan {
    return planConfigApply(document, this.entries);
  }

  /**
   * {@link validate} from editor text. A syntax error comes back as an ordinary rejected
   * plan, not an exception.
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
   * Apply a checked document through the owning services' setters, so the running app
   * follows without a reload. Writes only the settings that differ.
   *
   * Sequential, not concurrent: two entries can share one stored blob (the GIF provider
   * and its key do), and each setter rewrites the blob from the other's current value, so
   * overlapping them would let one write drop the other.
   */
  apply(plan: AcceptedConfigPlan): Observable<void> {
    return defer(() => {
      const byPath = new Map(this.entries.map((entry) => [entry.path, entry]));
      return from(plan.changes).pipe(
        concatMap((change) => {
          const entry = byPath.get(change.path);
          return entry ? runConfigAction(() => entry.write(change.to)) : of();
        }),
        toArray(),
        map(() => undefined),
      );
    });
  }

  /**
   * Restore every exported setting to its documented default through the owning services'
   * setters.
   *
   * Once started, the service owns the attempt even if the observer leaves; a bounded
   * observer receives a partial ledger while an asynchronous setter continues, and later
   * callers join the same attempt instead of issuing conflicting writes.
   */
  resetToDefaults(): Observable<ConfigResetOutcome> {
    return defer(() => {
      if (this.activeReset) return this.observeReset(this.activeReset);
      return this.observeReset(this.startReset(this.entries));
    });
  }

  /** Continue one partial attempt, preserving completed entries and writes in flight. */
  retryResetToDefaults(attempt: number): Observable<ConfigResetOutcome> {
    return defer(() => {
      if (this.activeReset) {
        return this.activeReset.id === attempt
          ? this.observeReset(this.activeReset)
          : of({ kind: 'unavailable', reason: 'stale-attempt' } as const);
      }
      const ledger = this.resetState();
      if (!ledger || ledger.attempt !== attempt) {
        return of({ kind: 'unavailable', reason: 'stale-attempt' } as const);
      }
      const outstanding = new Set(
        ledger.entries
          .filter((entry) => entry.status !== 'completed')
          .map((entry) => entry.entry),
      );
      if (outstanding.size === 0) {
        return of({ kind: 'unavailable', reason: 'nothing-to-retry' } as const);
      }
      return this.observeReset(
        this.startReset(
          this.entries.filter((entry) => outstanding.has(entry.path)),
          ledger.entries,
        ),
      );
    });
  }

  private startReset(
    entries: readonly ConfigEntry[],
    previous: readonly ConfigResetEntryOutcome[] = [],
  ): OwnedConfigResetAttempt {
    const id = ++this.resetAttempt;
    const retained = new Map(previous.map((entry) => [entry.entry, entry]));
    const selected = new Set(entries.map((entry) => entry.path));
    const initial = this.entries.map((entry): ConfigResetEntryOutcome =>
      selected.has(entry.path)
        ? { entry: entry.path, status: 'queued' }
        : (retained.get(entry.path) ?? {
            entry: entry.path,
            status: 'completed',
          }),
    );
    const completion = new ReplaySubject<ConfigResetOutcome>(1);
    const attempt: OwnedConfigResetAttempt = {
      id,
      completion,
      owner: new Subscription(),
    };
    this.activeReset = attempt;
    this.resetState.set({ attempt: id, status: 'running', entries: initial });
    attempt.owner.add(
      from(entries)
        .pipe(
          concatMap((entry) => {
            this.updateResetEntry(id, {
              entry: entry.path,
              status: 'in-progress',
            });
            return runConfigAction(() => entry.reset()).pipe(
              map((): ConfigResetEntryOutcome => ({
                entry: entry.path,
                status: 'completed',
              })),
              catchError(() =>
                of({
                  entry: entry.path,
                  status: 'failed',
                  diagnostic: { code: 'config-reset-entry-failed' },
                } as const),
              ),
              tap((outcome) => this.updateResetEntry(id, outcome)),
            );
          }),
          toArray(),
        )
        .subscribe({
          complete: () => this.settleReset(attempt),
        }),
    );
    return attempt;
  }

  private observeReset(
    attempt: OwnedConfigResetAttempt,
  ): Observable<ConfigResetOutcome> {
    return race(
      attempt.completion,
      timer(CONFIG_RESET_OBSERVATION_BUDGET_MS).pipe(
        map(() => this.resetOutcome(attempt.id)),
      ),
    );
  }

  private updateResetEntry(
    attempt: number,
    outcome: ConfigResetEntryOutcome,
  ): void {
    const ledger = this.resetState();
    if (!ledger || ledger.attempt !== attempt || ledger.status !== 'running') {
      return;
    }
    this.resetState.set({
      ...ledger,
      entries: ledger.entries.map((entry) =>
        entry.entry === outcome.entry ? outcome : entry,
      ),
    });
  }

  private settleReset(attempt: OwnedConfigResetAttempt): void {
    if (this.activeReset !== attempt) return;
    const ledger = this.resetState();
    if (!ledger || ledger.attempt !== attempt.id) return;
    const settled = { ...ledger, status: 'settled' as const };
    this.resetState.set(settled);
    this.activeReset = null;
    attempt.completion.next(resetOutcome(settled));
    attempt.completion.complete();
    attempt.owner.unsubscribe();
  }

  private resetOutcome(attempt: number): ConfigResetOutcome {
    const ledger = this.resetState();
    if (!ledger || ledger.attempt !== attempt) {
      return { kind: 'unavailable', reason: 'stale-attempt' };
    }
    return resetOutcome(ledger);
  }
}

function resetOutcome(ledger: ConfigResetLedger): ConfigResetOutcome {
  return {
    kind: ledger.entries.every((entry) => entry.status === 'completed')
      ? 'completed'
      : 'partial',
    attempt: ledger.attempt,
    entries: ledger.entries,
  };
}

function runConfigAction(action: () => ConfigAction): Observable<void> {
  return defer(() => {
    const result = action();
    const completion = isObservable(result)
      ? result
      : isPromiseResult(result)
        ? from(result)
        : of(result);
    return completion.pipe(
      map((outcome) => {
        assertConfigActionCompleted(outcome);
        return undefined;
      }),
    );
  });
}

function isPromiseResult(result: ConfigAction): result is Promise<void> {
  return (
    typeof result === 'object' &&
    result !== null &&
    'then' in result &&
    typeof result.then === 'function'
  );
}

function assertConfigActionCompleted(outcome: unknown): void {
  if (
    typeof outcome !== 'object' ||
    outcome === null ||
    !('kind' in outcome) ||
    outcome.kind === 'completed'
  ) {
    return;
  }
  const diagnostic =
    'diagnostic' in outcome &&
    typeof outcome.diagnostic === 'object' &&
    outcome.diagnostic !== null &&
    'code' in outcome.diagnostic &&
    typeof outcome.diagnostic.code === 'string'
      ? outcome.diagnostic.code
      : 'config-action-failed';
  throw new Error(`Config action failed (${diagnostic}).`);
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
  // Code point order, not `localeCompare`: a committed document's key order must not
  // depend on locale or ICU version.
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/**
 * Fail the registry build when two entries claim overlapping paths. Both collisions
 * silently drop a setting: the same path twice (the second `read()` wins), and one path
 * being a prefix of another (`push.gateway` beside `push.gateway.url`: the string leaf
 * and the branch overwrite each other). A dropped setting is invisible in the export.
 *
 * Checked across the whole registry, since colliding paths come from different libs.
 * Prefixes are tested explicitly, not inferred from sort order: `-` sorts below `.`, so
 * `push.gateway-x` can land between `push.gateway` and `push.gateway.url` and split a
 * colliding pair from a neighbour-only pass.
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
