import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter';

interface RegistryMetadataReporterOptions {
  readonly metadata: Readonly<Record<string, string>>;
}

/** Copy registry metadata onto every test so blob and JUnit preserve the same identity. */
export default class RegistryMetadataReporter implements Reporter {
  constructor(private readonly options: RegistryMetadataReporterOptions) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    const annotations = Object.entries(this.options.metadata).map(
      ([type, description]) => ({ type, description }),
    );
    for (const test of suite.allTests()) {
      const existing = new Set(test.annotations.map(({ type }) => type));
      test.annotations.push(
        ...annotations.filter(({ type }) => !existing.has(type)),
      );
    }
  }
}
