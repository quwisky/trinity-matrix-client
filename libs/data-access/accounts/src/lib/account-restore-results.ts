import type {
  AccountRestoreMetrics,
  AccountRestoreOutcome,
  AccountRestoreResult,
  AccountRuntimeOperation,
} from './account-runtime.models';
import type { AdapterAccountRestoreOutcome } from './account-runtime.adapter';

export function accountRestoreOutcomeFor(
  accountId: string,
  role: AccountRestoreOutcome['role'],
  durationMs: number,
  outcome: AdapterAccountRestoreOutcome,
): AccountRestoreOutcome {
  return outcome.kind === 'failed'
    ? { ...outcome, accountId, role, durationMs }
    : { kind: outcome.kind, accountId, role, durationMs };
}

export function accountRestoreResultFor(
  activeAccountId: string,
  accounts: readonly AccountRestoreOutcome[],
  durationMs: number,
): AccountRestoreResult {
  const metrics = accountRestoreMetrics(accounts, durationMs);
  const active = accounts.find((account) => account.role === 'active')!;
  if (active.kind !== 'ready') {
    return {
      kind: 'active-account-unavailable',
      activeAccountId,
      accounts,
      metrics,
    };
  }
  if (
    accounts.some(
      (account) => account.role === 'inactive' && account.kind !== 'ready',
    )
  ) {
    return {
      kind: 'restored-with-inactive-failures',
      activeAccountId,
      accounts,
      metrics,
    };
  }
  return { kind: 'restored', activeAccountId, accounts, metrics };
}

export function emptyAccountRestoreResult(
  kind: 'no-accounts' | 'local-state-unavailable',
  durationMs: number,
): AccountRestoreResult {
  return { kind, accounts: [], metrics: emptyMetrics(durationMs) };
}

export function accountRestoreTransitionResult(
  durationMs: number,
  operation: AccountRuntimeOperation = 'establishing-account',
): AccountRestoreResult {
  return {
    kind: 'transition-in-progress',
    operation,
    accounts: [],
    metrics: emptyMetrics(durationMs),
  };
}

function accountRestoreMetrics(
  accounts: readonly AccountRestoreOutcome[],
  durationMs: number,
): AccountRestoreMetrics {
  return {
    durationMs,
    activeTerminalMs:
      accounts.find((account) => account.role === 'active')?.durationMs ?? null,
    terminalAccounts: accounts.length,
    totalAccounts: accounts.length,
  };
}

function emptyMetrics(durationMs: number): AccountRestoreMetrics {
  return {
    durationMs,
    activeTerminalMs: null,
    terminalAccounts: 0,
    totalAccounts: 0,
  };
}
