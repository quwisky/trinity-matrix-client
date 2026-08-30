import {
  Injectable,
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import type {
  PreferenceDescriptor,
  PreferenceValue,
} from './preference.models';

export const PREFERENCE_DESCRIPTORS = new InjectionToken<
  readonly (readonly PreferenceDescriptor<PreferenceValue>[])[]
>('PREFERENCE_DESCRIPTORS');

export function providePreferenceDescriptors(
  useFactory: () => readonly PreferenceDescriptor<PreferenceValue>[],
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: PREFERENCE_DESCRIPTORS, multi: true, useFactory },
  ]);
}

@Injectable({ providedIn: 'root' })
export class PreferenceCatalogService {
  readonly descriptors = buildCatalog(
    inject(PREFERENCE_DESCRIPTORS, { optional: true }) ?? [],
  );

  private readonly byId = new Map(
    this.descriptors.map((descriptor) => [descriptor.id, descriptor]),
  );

  descriptor(id: string): PreferenceDescriptor<PreferenceValue> | undefined {
    return this.byId.get(id);
  }

  forSection(
    section: string,
  ): readonly PreferenceDescriptor<PreferenceValue>[] {
    return this.descriptors.filter(
      (descriptor) => descriptor.section === section,
    );
  }
}

function buildCatalog(
  groups: readonly (readonly PreferenceDescriptor<PreferenceValue>[])[],
): readonly PreferenceDescriptor<PreferenceValue>[] {
  const descriptors = groups.flat();
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) {
      throw new Error(`Duplicate preference descriptor '${descriptor.id}'.`);
    }
    ids.add(descriptor.id);
    assertPreferenceDescriptor(descriptor);
  }
  const byId = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor]),
  );
  for (const descriptor of descriptors) {
    const dependency = descriptor.editor.visibleWhen?.preferenceId;
    const dependencyDescriptor = dependency ? byId.get(dependency) : undefined;
    if (dependency && !dependencyDescriptor) {
      throw new Error(
        `Preference '${descriptor.id}' depends on unknown preference '${dependency}'.`,
      );
    }
    if (
      dependencyDescriptor &&
      dependencyDescriptor.scope !== descriptor.scope
    ) {
      throw new Error(
        `Preference '${descriptor.id}' and visibility dependency '${dependency}' need the same scope.`,
      );
    }
  }
  return descriptors.sort((left, right) => {
    if (left.section !== right.section) {
      return left.section < right.section ? -1 : 1;
    }
    if (left.order !== right.order) return left.order - right.order;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function assertPreferenceDescriptor(
  descriptor: PreferenceDescriptor<PreferenceValue>,
): void {
  const defaultValidation = descriptor.validate(descriptor.defaultValue);
  if (defaultValidation.kind === 'rejected') {
    throw new Error(
      `Preference '${descriptor.id}' rejects its documented default.`,
    );
  }
  if (!Number.isInteger(descriptor.order) || descriptor.order < 0) {
    throw new Error(
      `Preference '${descriptor.id}' needs a non-negative order.`,
    );
  }
  if (
    !Number.isInteger(descriptor.persistence.migration.currentVersion) ||
    descriptor.persistence.migration.currentVersion < 1
  ) {
    throw new Error(
      `Preference '${descriptor.id}' needs a positive migration version.`,
    );
  }
  if (
    descriptor.editor.kind === 'toggle' &&
    typeof descriptor.defaultValue !== 'boolean'
  ) {
    throw new Error(
      `Toggle preference '${descriptor.id}' needs a boolean default.`,
    );
  }
  if (
    descriptor.scope === 'server-authoritative' &&
    descriptor.storage !== 'server-authoritative'
  ) {
    throw new Error(
      `Server-authoritative preference '${descriptor.id}' needs server-authoritative storage.`,
    );
  }
  if (
    descriptor.sensitivity === 'secret' &&
    (descriptor.storage !== 'secure-store' || descriptor.export !== 'excluded')
  ) {
    throw new Error(
      `Secret preference '${descriptor.id}' must use secure-store storage and stay out of exports.`,
    );
  }
}
