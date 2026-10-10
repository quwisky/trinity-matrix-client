import { setTimeout as wait } from 'node:timers/promises';
import type { APIResponse } from '@playwright/test';

/** Bounds for {@link sendWithRetry}; the defaults suit Synapse's join and room-creation limits. */
export interface RetryOptions {
  /** Total requests to make, the first included. */
  maxAttempts?: number;
  /** Longest single wait, however large the server's `retry_after_ms` is. */
  maxWaitMs?: number;
  /** Wait used when a 429 carries no usable `retry_after_ms`. */
  fallbackWaitMs?: number;
}

/**
 * Send a Client-Server API request, honouring Synapse's rate limit.
 *
 * Synapse limits joins and room creation per user (a burst of 10, then one every ten
 * seconds), so seeding more rooms than that meets a `429` carrying `retry_after_ms`. The
 * wait is capped per attempt and the attempts are bounded. Any other failure, or a `429`
 * that outlasts the attempts, throws with `label`, so a bad seed fails at the request that
 * caused it rather than as a later count mismatch.
 */
export async function sendWithRetry(
  label: string,
  send: () => Promise<APIResponse>,
  options: RetryOptions = {},
): Promise<APIResponse> {
  const {
    maxAttempts = 6,
    maxWaitMs = 15_000,
    fallbackWaitMs = 1_000,
  } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await send();
    if (response.ok()) return response;
    if (response.status() !== 429) {
      throw new Error(
        `${label}: HTTP ${response.status()} ${await response.text()}`,
      );
    }
    if (attempt === maxAttempts) break;
    const body = (await response.json().catch(() => ({}))) as {
      retry_after_ms?: unknown;
    };
    const retryAfter = Number(body.retry_after_ms);
    await wait(
      Math.min(
        Math.max(retryAfter > 0 ? retryAfter : fallbackWaitMs, 1),
        maxWaitMs,
      ),
    );
  }
  throw new Error(`${label}: still rate-limited after ${maxAttempts} attempts`);
}
