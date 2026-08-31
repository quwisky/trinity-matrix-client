import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

interface RegistryMetadataReporterOptions {
  readonly metadata: Readonly<Record<string, string>>;
}

interface AnnotationTarget {
  readonly annotations: Array<{ type: string; description?: string }>;
}

/** Copy registry metadata onto every test so blob and JUnit preserve the same identity. */
export default class RegistryMetadataReporter implements Reporter {
  constructor(private readonly options: RegistryMetadataReporterOptions) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    for (const test of suite.allTests()) {
      this.annotate(test);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // The worker replaces annotations added during onBegin with its own result.
    // Restore registry identity after that replacement, before blob and JUnit
    // serialize the completed test.
    this.annotate(result);
    this.annotate(test);
  }

  private annotate(target: AnnotationTarget): void {
    const existing = new Set(target.annotations.map(({ type }) => type));
    target.annotations.push(
      ...Object.entries(this.options.metadata)
        .filter(([type]) => !existing.has(type))
        .map(([type, description]) => ({ type, description })),
    );
  }
}
