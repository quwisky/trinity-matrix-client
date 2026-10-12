import type { BuildInfo } from '@trinity/platform-native';

/** `Trinity v0.4.0 · 261efbe9`, the shape the issue template's version field asks for. */
export function buildLabel(build: BuildInfo | null): string {
  return build?.version
    ? `Trinity v${build.version} · ${build.commit || 'unknown'}`
    : 'Trinity (version unknown)';
}
