import type { ParamMap } from '@angular/router';
import {
  decodeRoomSegment,
  encodeRoomSegment,
  isValidUserId,
} from '@trinity/util/matrix';
import {
  RECENT_WORKSPACE_SCOPE,
  type WorkspaceDestination,
  type WorkspaceScope,
} from './workspace.models';

export interface ParsedWorkspaceUrl {
  readonly destination: WorkspaceDestination | null;
  readonly canonical: boolean;
}

export interface WorkspaceUrlCommands {
  readonly commands: readonly string[];
  readonly queryParams: Readonly<Record<string, string>>;
}

export function parseWorkspaceUrl(
  params: ParamMap,
  query: ParamMap,
  activeAccountId: string | null,
): ParsedWorkspaceUrl {
  const requestedAccount = query.get('account');
  const accountId =
    requestedAccount && isValidUserId(requestedAccount)
      ? requestedAccount
      : activeAccountId;
  if (!accountId) return { destination: null, canonical: false };

  let canonical = requestedAccount === accountId;
  const scope = parseScope(query);
  canonical &&= scope.canonical;

  const segment = params.get('roomId');
  let roomId = segment ? decodeRoomSegment(segment) : null;
  if (segment && !roomId) canonical = false;
  if (!scope.valid) roomId = null;

  const pane = parsePane(query, roomId);
  canonical &&= pane.canonical;
  if (!pane.valid) roomId = null;

  return {
    destination: {
      accountId,
      scope: scope.scope,
      roomId,
      pane: roomId ? pane.pane : 'list',
    },
    canonical,
  };
}

export function workspaceUrlOf(
  destination: WorkspaceDestination,
): WorkspaceUrlCommands {
  const commands = destination.roomId
    ? ['/rooms', encodeRoomSegment(destination.roomId)]
    : ['/rooms'];
  const queryParams: Record<string, string> = {
    account: destination.accountId,
  };
  if (destination.roomId && destination.pane === 'list') {
    queryParams['pane'] = 'list';
  }
  switch (destination.scope.kind) {
    case 'home':
      queryParams['view'] = 'home';
      break;
    case 'rooms':
      queryParams['view'] = 'rooms';
      break;
    case 'space':
      queryParams['space'] = encodeRoomSegment(destination.scope.spaceId);
      break;
    case 'recent':
      break;
  }
  return { commands, queryParams };
}

function parseScope(query: ParamMap): {
  readonly scope: WorkspaceScope;
  readonly canonical: boolean;
  readonly valid: boolean;
} {
  const view = query.get('view');
  const space = query.get('space');
  if (view && space) {
    return { scope: RECENT_WORKSPACE_SCOPE, canonical: false, valid: false };
  }
  if (space) {
    const spaceId = decodeRoomSegment(space);
    return spaceId
      ? { scope: { kind: 'space', spaceId }, canonical: true, valid: true }
      : { scope: RECENT_WORKSPACE_SCOPE, canonical: false, valid: false };
  }
  if (!view) {
    return { scope: RECENT_WORKSPACE_SCOPE, canonical: true, valid: true };
  }
  if (view === 'recent') {
    return { scope: RECENT_WORKSPACE_SCOPE, canonical: false, valid: true };
  }
  if (view === 'home' || view === 'rooms') {
    return { scope: { kind: view }, canonical: true, valid: true };
  }
  return { scope: RECENT_WORKSPACE_SCOPE, canonical: false, valid: false };
}

function parsePane(
  query: ParamMap,
  roomId: string | null,
): {
  readonly pane: 'list' | 'conversation';
  readonly canonical: boolean;
  readonly valid: boolean;
} {
  const requested = query.get('pane');
  if (!requested) {
    return {
      pane: roomId ? 'conversation' : 'list',
      canonical: true,
      valid: true,
    };
  }
  if (requested === 'list' && roomId) {
    return { pane: 'list', canonical: true, valid: true };
  }
  if (requested === 'conversation' && roomId) {
    return { pane: 'conversation', canonical: false, valid: true };
  }
  return { pane: 'list', canonical: false, valid: false };
}
