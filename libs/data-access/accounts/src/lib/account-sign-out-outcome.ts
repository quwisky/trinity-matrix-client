import type {
  AccountCleanupIssue,
  AccountSignOutOutcome,
} from './account-runtime.models';

export interface AccountSignOutSettlementContext {
  readonly accountId: string;
  readonly remainingAccountIds: readonly string[];
}

/** The Active Account after a removal: the live one while it remains, else the first remaining. */
export function survivingActiveAccount(
  liveActiveAccountId: string | null,
  remainingAccountIds: readonly string[],
): string | null {
  return liveActiveAccountId &&
    remainingAccountIds.includes(liveActiveAccountId)
    ? liveActiveAccountId
    : (remainingAccountIds[0] ?? null);
}

/** Build one settled Account-removal outcome from the live Active Account pointer. */
export function accountSignOutSettlement(
  liveActiveAccountId: string | null,
  context: AccountSignOutSettlementContext,
  issues: readonly AccountCleanupIssue[],
): Extract<
  AccountSignOutOutcome,
  { readonly kind: 'ready' | 'partial-cleanup' }
> {
  const base = {
    accountId: context.accountId,
    activeAccountId: survivingActiveAccount(
      liveActiveAccountId,
      context.remainingAccountIds,
    ),
    remainingAccountIds: context.remainingAccountIds,
  };
  return issues.length === 0
    ? { kind: 'ready', ...base }
    : { kind: 'partial-cleanup', ...base, issues };
}
