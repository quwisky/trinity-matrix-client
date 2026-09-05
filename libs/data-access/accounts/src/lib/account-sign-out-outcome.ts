import type {
  AccountCleanupIssue,
  AccountSignOutOutcome,
} from './account-runtime.models';

export interface AccountSignOutSettlementContext {
  readonly accountId: string;
  readonly remainingAccountIds: readonly string[];
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
  const activeAccountId =
    liveActiveAccountId &&
    context.remainingAccountIds.includes(liveActiveAccountId)
      ? liveActiveAccountId
      : (context.remainingAccountIds[0] ?? null);
  const base = {
    accountId: context.accountId,
    activeAccountId,
    remainingAccountIds: context.remainingAccountIds,
  };
  return issues.length === 0
    ? { kind: 'ready', ...base }
    : { kind: 'partial-cleanup', ...base, issues };
}
