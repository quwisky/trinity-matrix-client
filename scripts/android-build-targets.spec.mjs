import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const project = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../android/project.json'), 'utf8'),
);

describe('Android build targets', () => {
  it('never runs two Gradle builds of the same project concurrently', () => {
    // Both variants compile the same Capacitor plugin sources; parallel Gradle
    // runs corrupt each other's Kotlin incremental caches.
    const secondary = project.targets['build-secondary-prebuilt'];
    expect(secondary.options.command).toContain('./gradlew');
    expect(secondary.dependsOn).toEqual(
      expect.arrayContaining(['build-prebuilt']),
    );
  });
});
