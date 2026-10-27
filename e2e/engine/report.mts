export interface VitestReport {
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
}

/** A gated contract that skipped, or never reported, must not read as a pass. */
export function evaluateVitestReport(
  project: string,
  json: string | undefined,
): { readonly ok: boolean; readonly message: string } {
  if (json === undefined) {
    return { ok: false, message: `${project}: no test report written` };
  }
  let report: VitestReport;
  try {
    report = JSON.parse(json) as VitestReport;
  } catch {
    return { ok: false, message: `${project}: unreadable test report` };
  }
  const summary = `${project}: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped`;
  if (report.numPassedTests === 0 || report.numPendingTests > 0) {
    return { ok: false, message: `${summary}; gated specs did not run` };
  }
  return { ok: report.numFailedTests === 0, message: summary };
}
