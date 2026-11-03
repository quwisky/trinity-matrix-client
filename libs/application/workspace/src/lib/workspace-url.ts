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
import type { WorkspacePanel } from './workspace-surface.models';

export interface ParsedWorkspaceUrl {
  readonly destination: WorkspaceDestination | null;
  readonly eventId?: string;
  readonly canonical: boolean;
}

export interface WorkspaceUrlCommands {
  readonly commands: readonly string[];
  readonly queryParams: Readonly<Record<string, string>>;
}

interface WorkspaceParameters {
  get(name: string): string | null;
}

export function parseWorkspaceUrl(
  params: WorkspaceParameters,
  query: WorkspaceParameters,
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

  const requestedPanel = parsePanel(
    query,
    roomId !== null && pane.pane !== 'list',
  );
  canonical &&= requestedPanel.canonical;

  const requestedEvent = query.get('event');
  const eventId = parseEventId(requestedEvent, roomId);
  if (requestedEvent && !eventId) canonical = false;

  return {
    destination: {
      accountId,
      scope: scope.scope,
      roomId,
      pane: roomId ? pane.pane : 'list',
      panel: requestedPanel.panel,
    },
    ...(eventId ? { eventId } : {}),
    canonical,
  };
}

export function workspaceUrlOf(
  destination: WorkspaceDestination,
  eventId?: string | null,
): WorkspaceUrlCommands {
  const commands = destination.roomId
    ? ['/rooms', encodeRoomSegment(destination.roomId)]
    : ['/rooms'];
  const queryParams: Record<string, string> = {
    account: destination.accountId,
  };
  if (destination.roomId && eventId) queryParams['event'] = eventId;
  if (destination.roomId && destination.pane === 'list') {
    queryParams['pane'] = 'list';
  }
  if (destination.roomId && destination.pane !== 'list' && destination.panel) {
    queryParams['panel'] = destination.panel.kind;
    if (destination.panel.kind === 'thread') {
      queryParams['root'] = destination.panel.root;
    }
  }
  switch (destination.scope.kind) {
    case 'home':
      queryParams['view'] = 'home';
      break;
    case 'rooms':
      queryParams['view'] = 'rooms';
      break;
    case 'inbox':
      queryParams['view'] = 'inbox';
      break;
    case 'space':
      queryParams['space'] = encodeRoomSegment(destination.scope.spaceId);
      break;
    case 'recent':
      break;
  }
  return { commands, queryParams };
}

function parseEventId(
  value: string | null,
  roomId: string | null,
): string | null {
  return roomId && value?.startsWith('$') && value.length > 1 ? value : null;
}

function parseScope(query: WorkspaceParameters): {
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
  if (view === 'home' || view === 'rooms' || view === 'inbox') {
    return { scope: { kind: view }, canonical: true, valid: true };
  }
  return { scope: RECENT_WORKSPACE_SCOPE, canonical: false, valid: false };
}

function parsePane(
  query: WorkspaceParameters,
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

const PANEL_KINDS = ['members', 'threads', 'pinned', 'search'] as const;

/** Event IDs start with `$`; anything else in the URL is not trusted as one. */
const EVENT_ID = /^\$[\w+/=.:[\]-]{1,254}$/;

function parsePanel(
  query: WorkspaceParameters,
  allowed: boolean,
): { readonly panel: WorkspacePanel | null; readonly canonical: boolean } {
  const kind = query.get('panel');
  const root = query.get('root');
  if (!kind && !root) return { panel: null, canonical: true };
  const none = { panel: null, canonical: false };
  if (!allowed) return none;
  if (kind === 'thread') {
    return root && EVENT_ID.test(root)
      ? { panel: { kind, root }, canonical: true }
      : none;
  }
  const known = PANEL_KINDS.find((candidate) => candidate === kind);
  return known && !root ? { panel: { kind: known }, canonical: true } : none;
}

/**
 * Whether a navigation between two Workspace URLs only opened, switched or closed the open
 * Room's panel, which the Room's surface owns focus for. Opening one also drops `event`.
 */
export function isWorkspacePanelChange(
  previous: string,
  next: string,
): boolean {
  const parse = (url: string) => new URL(url, 'https://trinity.invalid');
  const before = parse(previous);
  const after = parse(next);
  const panelOf = (url: URL) =>
    `${url.searchParams.get('panel')} ${url.searchParams.get('root')}`;
  const placeOf = (url: URL) => {
    const query = new URLSearchParams(url.searchParams);
    for (const key of ['panel', 'root', 'event']) query.delete(key);
    query.sort();
    return `${url.pathname}?${query}`;
  };
  return (
    before.pathname.startsWith('/rooms/') &&
    panelOf(before) !== panelOf(after) &&
    placeOf(before) === placeOf(after)
  );
}
