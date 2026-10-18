import type { APIRequestContext } from '../../fixtures.mts';
import type { AccountSession } from '../../support/account.mts';
import { describeFailure } from '../../support/http-failure.mts';

/** Create a private room (or, with `space`, a space) as `user`, returning its id. */
export async function createRoom(
  request: APIRequestContext,
  hs: string,
  user: Pick<AccountSession, 'accessToken'>,
  name: string,
  options: {
    readonly space?: boolean;
    readonly invite?: readonly string[];
  } = {},
): Promise<string> {
  const res = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${user.accessToken}` },
    data: {
      name,
      preset: 'private_chat',
      ...(options.space ? { creation_content: { type: 'm.space' } } : {}),
      ...(options.invite ? { invite: options.invite } : {}),
    },
  });
  if (!res.ok()) {
    throw new Error(await describeFailure(`createRoom ${name}`, res));
  }
  return (await res.json()).room_id as string;
}

/** Link `childId` under `spaceId` with an `m.space.child` state event. */
export async function linkChild(
  request: APIRequestContext,
  hs: string,
  user: AccountSession,
  spaceId: string,
  childId: string,
): Promise<void> {
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(
      spaceId,
    )}/state/m.space.child/${encodeURIComponent(childId)}`,
    {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      // `via` must be non-empty or the link reads as a removed child.
      data: { via: [serverNameOf(user)] },
    },
  );
  if (!res.ok()) {
    throw new Error(
      await describeFailure(`m.space.child ${spaceId}→${childId}`, res),
    );
  }
}

/** POST a membership action (`join`, `leave`, `kick`) on a room as `user`. */
export async function membership(
  request: APIRequestContext,
  hs: string,
  user: Pick<AccountSession, 'accessToken'>,
  roomId: string,
  action: 'join' | 'leave' | 'kick',
  data: Record<string, unknown> = {},
): Promise<void> {
  const res = await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/${action}`,
    { headers: { Authorization: `Bearer ${user.accessToken}` }, data },
  );
  if (!res.ok()) {
    throw new Error(await describeFailure(`${action} ${roomId}`, res));
  }
}

/** The server part of a user id, `@user:server` → `server`. */
export function serverNameOf(user: AccountSession): string {
  return user.userId.slice(user.userId.indexOf(':') + 1);
}

/** A Matrix id in the base64url form Workspace URLs carry for rooms and spaces. */
export function urlSegment(id: string): string {
  return Buffer.from(id).toString('base64url');
}
