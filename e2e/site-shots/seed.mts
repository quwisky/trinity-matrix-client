import type { APIRequestContext } from '@playwright/test';
import { apiLogin, registerUser, type ApiUser } from '../support/account.mts';
import { sendWithRetry } from '../browser/support/cs-api.mts';
import {
  createRoom,
  linkChild,
  membership,
} from '../browser/support/space-journey.mts';

// Synthetic people and conversation for the landing-page scenes. Nothing here names a real
// person, server or account; the homeserver is the run's disposable one.

export interface SceneAccount extends ApiUser {
  readonly user: string;
  readonly pass: string;
}

export interface SceneData {
  readonly alex: SceneAccount;
  readonly work: SceneAccount;
  readonly spaceId: string;
  readonly generalId: string;
  readonly launchId: string;
  readonly threadRootId: string;
}

// Short lines, so the block fits a phone without scrolling sideways.
const CODE = `async function retry(job) {
  for (let n = 1; ; n++) {
    try {
      return await job();
    } catch (err) {
      if (n >= 5) throw err;
      await sleep(backoff(n));
    }
  }
}`;
const MATHS = String.raw`\operatorname{backoff}(n) = \min\left(t_{\max},\ t_0 \cdot 2^{n}\right)`;

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

let txn = 0;

async function account(
  request: APIRequestContext,
  hs: string,
  user: string,
  displayName: string,
): Promise<SceneAccount> {
  const pass = `${user}-site-pass`;
  await registerUser(request, user, pass);
  const session = await apiLogin(request, hs, user, pass);
  await sendWithRetry(`display name ${user}`, () =>
    request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(session.userId)}/displayname`,
      { headers: session.headers, data: { displayname: displayName } },
    ),
  );
  return { ...session, user, pass };
}

async function send(
  request: APIRequestContext,
  hs: string,
  from: ApiUser,
  roomId: string,
  type: string,
  content: Record<string, unknown>,
): Promise<string> {
  const response = await sendWithRetry(`send ${type}`, () =>
    request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/site-${Date.now()}-${txn++}`,
      { headers: from.headers, data: content },
    ),
  );
  return ((await response.json()) as { event_id: string }).event_id;
}

/** Seed both accounts, the space and its conversation through the client-server API. */
export async function seedScenes(
  request: APIRequestContext,
  hs: string,
): Promise<SceneData> {
  const alex = await account(request, hs, 'alex', 'Alex Rivera');
  const work = await account(request, hs, 'alex-work', 'Alex (Work)');
  const jordan = await account(request, hs, 'jordan', 'Jordan Lee');

  const text = (from: ApiUser, roomId: string, body: string, html?: string) =>
    send(request, hs, from, roomId, 'm.room.message', {
      msgtype: 'm.text',
      body,
      ...(html
        ? { format: 'org.matrix.custom.html', formatted_body: html }
        : {}),
    });
  const reply = (from: ApiUser, roomId: string, rootId: string, body: string) =>
    send(request, hs, from, roomId, 'm.room.message', {
      msgtype: 'm.text',
      body,
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: rootId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: rootId },
      },
    });
  const react = (from: ApiUser, roomId: string, eventId: string, key: string) =>
    send(request, hs, from, roomId, 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
    });

  // The second account needs a room of its own to show its display name.
  await createRoom(request, hs, work, 'Team standup');

  const spaceId = await createRoom(request, hs, alex, 'Design Studio', {
    space: true,
    invite: [jordan.userId],
  });
  await membership(request, hs, jordan, spaceId, 'join');
  const rooms: string[] = [];
  for (const name of ['General', 'Launch plan', 'Random']) {
    const roomId = await createRoom(request, hs, alex, name, {
      invite: [jordan.userId],
    });
    await membership(request, hs, jordan, roomId, 'join');
    await linkChild(request, hs, alex, spaceId, roomId);
    rooms.push(roomId);
  }
  const [generalId, launchId, randomId] = rooms as [string, string, string];

  await text(jordan, randomId, 'Anyone up for lunch at the new ramen place?');

  await text(
    jordan,
    generalId,
    'Morning! The new onboarding flow is live on staging.',
  );
  const retry = await text(
    alex,
    generalId,
    `I tightened the retry helper before we ship:\n\`\`\`js\n${CODE}\n\`\`\``,
    `<p>I tightened the retry helper before we ship:</p><pre><code class="language-js">${escapeHtml(CODE)}</code></pre>`,
  );
  await react(jordan, generalId, retry, '🚀');
  const maths = await text(
    jordan,
    generalId,
    `And the wait before attempt n: $$${MATHS}$$`,
    `<p>And the wait before attempt n:</p><div data-mx-maths="${escapeHtml(MATHS)}"><code>${escapeHtml(MATHS)}</code></div>`,
  );
  await react(alex, generalId, maths, '👍');
  await text(
    alex,
    generalId,
    'Exactly. Capped at thirty seconds so nobody waits forever.',
  );

  await text(
    jordan,
    launchId,
    'Release notes are drafted and in the shared folder.',
  );
  const threadRootId = await text(
    alex,
    launchId,
    'Launch checklist for Friday: anything still missing?',
  );
  await react(jordan, launchId, threadRootId, '👀');
  await react(alex, launchId, threadRootId, '✅');
  await reply(
    jordan,
    launchId,
    threadRootId,
    'The store listing images need a final pass.',
  );
  await reply(
    alex,
    launchId,
    threadRootId,
    'On it. I will also update the changelog.',
  );
  await reply(
    jordan,
    launchId,
    threadRootId,
    'Perfect, then we are good to go.',
  );

  return { alex, work, spaceId, generalId, launchId, threadRootId };
}
