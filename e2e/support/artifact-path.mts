/** Reject path traversal and separators in registry-owned artifact segments. */
export function assertE2EArtifactPathSegment(
  value: string,
  label: string,
): void {
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(value)) {
    throw new Error(`Invalid E2E ${label} path segment: ${value}`);
  }
}
