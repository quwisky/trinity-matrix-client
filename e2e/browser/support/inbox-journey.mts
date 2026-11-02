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
 * A failed homeserver request is part of the protocol (a 404 for absent account data, say), so only
 * a failed load from elsewhere counts.
 */
export function watchConsoleErrors(page: Page): () => readonly string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url } = message.location();
    if (
      message.text().startsWith('Failed to load resource') &&
      new URL(url || 'about:blank').pathname.startsWith('/_matrix/')
    ) {
      return;
    }
    problems.push(`console: ${message.text()} ${url}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return () => problems;
}

/** Opens the inbox from the rail and waits for its list to leave loading. */
export async function openInbox(page: Page): Promise<void> {
  await page.getByTestId('rail-inbox').click();
  await expect(page.getByTestId('inbox-scroll')).toBeVisible();
  await expect(page.getByTestId('inbox-loading')).toHaveCount(0, {
    timeout: 30_000,
  });
}
