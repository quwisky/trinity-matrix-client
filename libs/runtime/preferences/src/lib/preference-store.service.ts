import {
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  Observable,
  concatMap,
  defer,
  from,
  map,
  of,
  switchMap,
  toArray,
} from 'rxjs';
import {
  PreferenceCatalogService,
  assertPreferenceDescriptor,
} from './preference-catalog.service';
import {
  type PreferenceCatalogEntry,
  type PreferenceCommandOutcome,
  type PreferenceContext,
  type PreferenceDescriptor,
  type PreferenceFailure,
  type PreferenceHydrationOutcome,
  type PreferenceState,
  type PreferenceValue,
} from './preference.models';
import {
  decodeStoredPreference,
  encodeStoredPreference,
  preferenceContextKey,
  preferenceFailureState,
  preferenceHydrationOutcome,
  preferenceScopeFailure,
  preferenceStorageCommandFailure,
  preferenceStorageFailure,
  preferenceStorageRequest,
  rejectedPreferenceCommand,
  unavailablePreferenceCommand,
} from './preference-store.helpers';
import { PREFERENCE_STORAGE_ADAPTER } from './preference-storage';

type PreferenceCell = WritableSignal<PreferenceState<PreferenceValue>>;

@Injectable({ providedIn: 'root' })
export class PreferenceStoreService {
  private readonly catalog = inject(PreferenceCatalogService);
  private readonly adapter = inject(PREFERENCE_STORAGE_ADAPTER, {
    optional: true,
  });
  private readonly cells = new Map<string, PreferenceCell>();
  private readonly descriptorsById = new Map<
    string,
    PreferenceDescriptor<PreferenceValue>
  >();

  state(
    id: string,
    context: PreferenceContext,
  ): Signal<PreferenceState<PreferenceValue>> {
    return this.cell(this.requireDescriptor(id), context).asReadonly();
  }

  value(id: string, context: PreferenceContext): Signal<PreferenceValue> {
    const state = this.state(id, context);
    return computed(() => state().value);
  }

  valueFor(
    descriptor: PreferenceDescriptor<PreferenceValue>,
    context: PreferenceContext,
  ): Signal<PreferenceValue> {
    this.rememberDescriptor(descriptor);
    const state = this.cell(descriptor, context).asReadonly();
    return computed(() => state().value);
  }

  entries(
    section: string,
    context: PreferenceContext,
  ): readonly PreferenceCatalogEntry[] {
    return this.catalog
      .forSection(section)
      .filter((descriptor) => descriptor.scope === context.kind)
      .map((descriptor) => this.catalogEntry(descriptor, context));
  }

  hydrate(
    context: PreferenceContext,
    preferenceIds?: readonly string[],
  ): Observable<PreferenceHydrationOutcome> {
    return defer(() => {
      if (!preferenceIds) {
        return this.hydrateSelected(
          context,
          this.catalog.descriptors.filter(
            (descriptor) => descriptor.scope === context.kind,
          ),
        );
      }
      const selected: PreferenceDescriptor<PreferenceValue>[] = [];
      const missing: PreferenceFailure[] = [];
      for (const id of preferenceIds) {
        const descriptor = this.catalog.descriptor(id);
        if (descriptor) {
          selected.push(descriptor);
        } else {
          missing.push({
            preferenceId: id,
            recovery: 'fix-value',
            diagnostic: { code: 'preference-not-registered' },
          });
        }
      }
      return this.hydrateSelected(context, selected, missing);
    });
  }

  hydrateDescriptors(
    context: PreferenceContext,
    descriptors: readonly PreferenceDescriptor<PreferenceValue>[],
  ): Observable<PreferenceHydrationOutcome> {
    return defer(() => {
      descriptors.forEach((descriptor) => this.rememberDescriptor(descriptor));
      return this.hydrateSelected(context, descriptors);
    });
  }

  set(
    id: string,
    context: PreferenceContext,
    candidate: unknown,
  ): Observable<PreferenceCommandOutcome> {
    return defer(() => {
      const descriptor = this.catalog.descriptor(id);
      if (!descriptor) {
        return of(
          rejectedPreferenceCommand('preference-not-registered', 'fix-value'),
        );
      }
      return this.setPreference(descriptor, context, candidate);
    });
  }

  setPreference(
    descriptor: PreferenceDescriptor<PreferenceValue>,
    context: PreferenceContext,
    candidate: unknown,
  ): Observable<PreferenceCommandOutcome> {
    return defer(() => {
      this.rememberDescriptor(descriptor);
      if (descriptor.scope !== context.kind) {
        return of(
          rejectedPreferenceCommand(
            'preference-scope-mismatch',
            'select-matching-scope',
          ),
        );
      }
      const validation = descriptor.validate(candidate);
      if (validation.kind === 'rejected') {
        return of({
          kind: 'rejected',
          recovery: 'fix-value',
          diagnostic: { code: 'preference-validation-rejected' },
        } as const);
      }
      if (!this.adapter) {
        return of(
          unavailablePreferenceCommand('preference-storage-unavailable'),
        );
      }
      const request = preferenceStorageRequest(descriptor, context);
      return this.adapter
        .write({
          ...request,
          payload: encodeStoredPreference(
            descriptor.persistence.migration.currentVersion,
            validation.value,
          ),
        })
        .pipe(
          map((outcome) => {
            if (outcome.kind === 'completed') {
              this.cell(descriptor, context).set({
                kind: 'ready',
                value: validation.value,
              });
              return { kind: 'completed' } as const;
            }
            return preferenceStorageCommandFailure(outcome);
          }),
        );
    });
  }

  reset(
    id: string,
    context: PreferenceContext,
  ): Observable<PreferenceCommandOutcome> {
    return defer(() => {
      const descriptor = this.catalog.descriptor(id);
      if (!descriptor) {
        return of(
          rejectedPreferenceCommand('preference-not-registered', 'fix-value'),
        );
      }
      return this.setPreference(descriptor, context, descriptor.defaultValue);
    });
  }

  private catalogEntry(
    descriptor: PreferenceDescriptor<PreferenceValue>,
    context: PreferenceContext,
  ): PreferenceCatalogEntry {
    const state = this.state(descriptor.id, context);
    const condition = descriptor.editor.visibleWhen;
    const dependency = condition
      ? this.state(condition.preferenceId, context)
      : undefined;
    const visible = computed(
      () =>
        !condition ||
        (dependency ? dependency().value === condition.equals : false),
    );
    return {
      id: descriptor.id,
      owner: descriptor.owner,
      section: descriptor.section,
      order: descriptor.order,
      scope: descriptor.scope,
      defaultValue: descriptor.defaultValue,
      sensitivity: descriptor.sensitivity,
      storage: descriptor.storage,
      export: descriptor.export,
      editor: descriptor.editor,
      state,
      visible,
      set: (value) => this.set(descriptor.id, context, value),
    };
  }

  private hydrateSelected(
    context: PreferenceContext,
    selected: readonly PreferenceDescriptor<PreferenceValue>[],
    initialFailures: readonly PreferenceFailure[] = [],
  ): Observable<PreferenceHydrationOutcome> {
    const descriptors = selected.filter(
      (descriptor) => descriptor.scope === context.kind,
    );
    const mismatches = selected
      .filter((descriptor) => descriptor.scope !== context.kind)
      .map((descriptor) => preferenceScopeFailure(descriptor.id));
    return from(descriptors).pipe(
      concatMap((descriptor) => this.hydrateOne(descriptor, context)),
      toArray(),
      map((results) =>
        preferenceHydrationOutcome([
          ...initialFailures,
          ...mismatches,
          ...results,
        ]),
      ),
    );
  }

  private hydrateOne(
    descriptor: PreferenceDescriptor<PreferenceValue>,
    context: PreferenceContext,
  ): Observable<PreferenceFailure | null> {
    const cell = this.cell(descriptor, context);
    if (!this.adapter) {
      const failure = preferenceStorageFailure(
        descriptor.id,
        'preference-storage-unavailable',
      );
      cell.set(preferenceFailureState(descriptor.defaultValue, failure));
      return of(failure);
    }
    const request = preferenceStorageRequest(descriptor, context);
    return this.adapter.read(request).pipe(
      switchMap((outcome) => {
        if (outcome.kind === 'missing') {
          cell.set({ kind: 'ready', value: descriptor.defaultValue });
          return of(null);
        }
        if (outcome.kind === 'unavailable') {
          const failure: PreferenceFailure = {
            preferenceId: descriptor.id,
            recovery: 'retry-storage',
            diagnostic: { code: 'preference-storage-read-failed' },
          };
          cell.set(preferenceFailureState(descriptor.defaultValue, failure));
          return of(failure);
        }
        return this.applyStored(descriptor, context, outcome.payload, cell);
      }),
    );
  }

  private applyStored(
    descriptor: PreferenceDescriptor<PreferenceValue>,
    context: PreferenceContext,
    payload: string,
    cell: PreferenceCell,
  ): Observable<PreferenceFailure | null> {
    const decoded = decodeStoredPreference(payload);
    let migrated: ReturnType<typeof descriptor.persistence.migration.migrate>;
    try {
      migrated = descriptor.persistence.migration.migrate(decoded.stored);
    } catch {
      const failure: PreferenceFailure = {
        preferenceId: descriptor.id,
        recovery: 'reset-preference',
        diagnostic: { code: 'preference-migration-rejected' },
      };
      cell.set(preferenceFailureState(descriptor.defaultValue, failure));
      return of(failure);
    }
    if (migrated.kind === 'rejected') {
      const failure: PreferenceFailure = {
        preferenceId: descriptor.id,
        recovery: 'reset-preference',
        diagnostic: { code: 'preference-migration-rejected' },
      };
      cell.set(preferenceFailureState(descriptor.defaultValue, failure));
      return of(failure);
    }
    cell.set({ kind: 'ready', value: migrated.value });
    if (
      decoded.enveloped &&
      decoded.stored.version === descriptor.persistence.migration.currentVersion
    ) {
      return of(null);
    }
    if (!this.adapter) return of(null);
    return this.adapter
      .write({
        ...preferenceStorageRequest(descriptor, context),
        payload: encodeStoredPreference(
          descriptor.persistence.migration.currentVersion,
          migrated.value,
        ),
      })
      .pipe(
        map((outcome) => {
          if (outcome.kind === 'completed') return null;
          const failure: PreferenceFailure = {
            preferenceId: descriptor.id,
            recovery: 'retry-storage',
            diagnostic: { code: 'preference-storage-write-failed' },
          };
          cell.set(preferenceFailureState(migrated.value, failure));
          return failure;
        }),
      );
  }

  private cell(
    descriptor: PreferenceDescriptor<PreferenceValue>,
    context: PreferenceContext,
  ): PreferenceCell {
    this.rememberDescriptor(descriptor);
    if (descriptor.scope !== context.kind) {
      throw new Error(
        `Preference '${descriptor.id}' cannot use '${context.kind}' scope.`,
      );
    }
    const key = `${preferenceContextKey(context)}\u0000${descriptor.id}`;
    let cell = this.cells.get(key);
    if (!cell) {
      cell = signal<PreferenceState<PreferenceValue>>({
        kind: 'default',
        value: descriptor.defaultValue,
      });
      this.cells.set(key, cell);
    }
    return cell;
  }

  private requireDescriptor(id: string): PreferenceDescriptor<PreferenceValue> {
    const descriptor = this.catalog.descriptor(id);
    if (!descriptor) throw new Error(`Unknown preference '${id}'.`);
    return descriptor;
  }

  private rememberDescriptor(
    descriptor: PreferenceDescriptor<PreferenceValue>,
  ): void {
    const known = this.descriptorsById.get(descriptor.id);
    if (known && known !== descriptor) {
      throw new Error(
        `Preference '${descriptor.id}' was supplied with conflicting descriptors.`,
      );
    }
    if (!known) {
      assertPreferenceDescriptor(descriptor);
      this.descriptorsById.set(descriptor.id, descriptor);
    }
  }
}
