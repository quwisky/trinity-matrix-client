import { expect, type APIRequestContext, type Page } from '../../fixtures.mts';
import { apiLogin, type ApiUser } from '../../support/account.mts';
import type { MatrixTestResources } from '../../support/test-resources.mts';
import { sendWithRetry } from './cs-api.mts';
import { seedLiveNotifyReader } from './multi-account-journey.mts';

/** The reader's keyword rule highlights on this word alone, as in keyword-notifications. */
export const KEYWORD = 'zarquon';

export interface InboxSeed {
  readonly user: string;
  readonly pass: string;
  readonly reader: ApiUser;
  readonly sender: ApiUser;
  readonly roomId: string;
  readonly roomName: string;
  readonly senderName: string;
  /** Posts one message as the sender and returns its event id; `rootId` makes it a thread reply. */
  readonly post: (body: string, rootId?: string) => Promise<string>;
}

/**
 * A reader and a sender in a two-person room (so the server's default rules notify every message),
 * with a keyword rule that highlights `KEYWORD`. Nothing is posted yet.
 */
export async function seedInbox(
  request: APIRequestContext,
  hs: string,
  resources: MatrixTestResources,
  roomName?: string,
): Promise<InboxSeed> {
  const seed = await seedLiveNotifyReader(request, hs, resources);
  const reader = await apiLogin(request, hs, seed.user, seed.pass);
  await sendWithRetry('keyword rule', () =>
    request.put(`${hs}/_matrix/client/v3/pushrules/global/content/${KEYWORD}`, {
      headers: reader.headers,
      data: {
        pattern: KEYWORD,
        actions: ['notify', { set_tweak: 'highlight' }],
      },
    }),
  );
  if (roomName) {
    // The reader created the room, so only they may rename it.
    await sendWithRetry('rename room', () =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(seed.roomId)}/state/m.room.name`,
        { headers: reader.headers, data: { name: roomName } },
      ),
    );
  }
  const txn = resources.namespace.role('inbox-msg');
  let count = 0;
  const post = async (body: string, rootId?: string): Promise<string> => {
    const content: Record<string, unknown> = { msgtype: 'm.text', body };
    if (rootId) {
      content['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: rootId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: rootId },
      };
    }
    const response = await sendWithRetry(`send ${body.slice(0, 20)}`, () =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(seed.roomId)}/send/m.room.message/${txn}-${count++}`,
        { headers: seed.sender.headers, data: content },
      ),
    );
    return ((await response.json()) as { event_id: string }).event_id;
  };
  return {
    ...seed,
    reader,
    roomName: roomName ?? seed.roomName,
    post,
  };
}

/**
 * Collects what the page logs as errors, which includes CSP violations, and uncaught exceptions.
 * A homeserver answers 404 for absent data as part of the protocol, so only that status is let
 * through; any other failed load fails the journey unless `allowed` names its URL.
 */
export function watchConsoleErrors(
  page: Page,
  allowed: (url: string) => boolean = () => false,
): () => readonly string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url } = message.location();
    const text = message.text();
    // The SDK logs its own error when a server, such as CI's Tuwunel, has no TURN set up.
    if (text.startsWith('Failed to get TURN URIs M_NOT_FOUND')) return;
    if (text.startsWith('Failed to load resource')) {
      const { pathname } = new URL(url || 'about:blank');
      if (pathname.startsWith('/_matrix/') && text.includes('status of 404')) {
        return;
      }
      if (allowed(url)) return;
    }
    problems.push(`console: ${text} ${url}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return () => problems;
}

/**
 * Opens the inbox from the rail and waits for its list to leave loading and for its rows to have
 * their rooms: a first sync slower than the inbox's wait leaves room IDs until it lands.
 */
export async function openInbox(page: Page): Promise<void> {
  await page.getByTestId('rail-inbox').click();
  await expect(page.getByTestId('inbox-scroll')).toBeVisible();
  await expect(page.getByTestId('inbox-loading')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.locator('.row__room', { hasText: /^\s*!/ })).toHaveCount(
    0,
    {
      timeout: 30_000,
    },
  );
}

/** Holds the page's /sync requests at the browser until the returned function is called. */
export async function holdSync(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/_matrix/client/v3/sync*', async (route) => {
    await released;
    // The page may have reloaded or closed while this one waited.
    await route.continue().catch(() => undefined);
  });
  return release;
}
