/** Explicit observation budget for every asynchronous destructive-cleanup step. */
export const ACCOUNT_CLEANUP_STEP_BUDGET_MS = {
  registryRead: 3_000,
  sessionRead: 3_000,
  notificationUnregister: 3_000,
  providerLogout: 3_000,
  matrixLogout: 3_000,
  matrixStop: 3_000,
  databaseWipe: 6_000,
  registryWrite: 3_000,
  secureStorageWipe: 3_000,
  preferencesWipe: 3_000,
  webStorageWipe: 3_000,
  cacheStorageWipe: 3_000,
  serviceWorkerRegistrationWipe: 3_000,
} as const;
