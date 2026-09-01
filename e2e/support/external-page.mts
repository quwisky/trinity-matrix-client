interface ExternalPageCandidate {
  url(): string;
}

/**
 * Finds the external page affected by one trigger. Android Custom Tabs may
 * either create a Playwright Page or reuse and navigate one already owned by
 * Chrome, so identity alone is not a sufficient signal.
 */
export function findTriggeredExternalPage<T extends ExternalPageCandidate>(
  before: ReadonlyMap<T, string>,
  current: readonly T[],
): T | undefined {
  return current.find(
    (candidate) =>
      !before.has(candidate) || before.get(candidate) !== candidate.url(),
  );
}
