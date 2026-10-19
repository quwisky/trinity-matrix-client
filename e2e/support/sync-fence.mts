import type { APIRequestContext, Page, Route } from '@playwright/test';
import type { HomeserverSession } from './app.mts';
import { isTuwunel } from './homeserver/kind.mts';

/**
 * Run `write`, which changes room state, while none of `page`'s /sync requests is waiting
 * at the server.
 *
 * Tuwunel 1.9.3 makes a new state event visible to /sync and wakes waiting syncs
 * (`append_pdu`) before it moves the room's current state onto it (`set_room_state`).
 * MSC4222 `state_after` for the last timeline event reads that current state, so a
 * sync woken in between carries the new event in its timeline but the old state in
 * `state_after`. Clients must not apply timeline state under MSC4222, so the update
 * is lost until that state key changes again. On Tuwunel, hold the next /sync at the
 * browser, wake and finish the one already waiting, and release it after `write`
 * returns. The app still receives the change through an ordinary incremental sync.
 * Synapse runs `write` unfenced, so the nightly Synapse run still covers a sync that a
 * state change wakes.
 */
export async function withSyncFence(
  page: Page,
  request: APIRequestContext,
  session: HomeserverSession,
  auth: { readonly userId: string; readonly headers: Record<string, string> },
  write: () => Promise<void>,
): Promise<void> {
  if (!isTuwunel(session.kind)) {
    await write();
    return;
  }
  const sync = '**/_matrix/client/v3/sync?*';
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let gated = false;
  let atGate!: () => void;
  // The SDK syncs one request at a time, so a request at the gate means none is
  // waiting at the server.
  const reachedGate = new Promise<void>((resolve) => (atGate = resolve));
  const hold = async (route: Route): Promise<void> => {
    gated = true;
    atGate();
    await released;
    await route.continue();
  };
  // Hold only the next request; the route then removes itself, so no unroute can race
  // the held request.
  await page.route(sync, hold, { times: 1 });
  try {
    // Account data wakes the sync that is already waiting, so it returns.
    await request.put(
      `${session.hs as string}/_matrix/client/v3/user/${encodeURIComponent(auth.userId)}/account_data/dev.trinityproject.trinity.e2e.sync_fence`,
      { headers: auth.headers, data: { at: Date.now() } },
    );
    await reachedGate;
    await write();
  } finally {
    release();
    if (!gated) await page.unroute(sync, hold);
  }
}
