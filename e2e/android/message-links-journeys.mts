import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { publicStageFailure } from '../support/public-failure.mts';
import { readSession } from '../support/session.mts';
import { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  JOIN_ROOM_LABEL,
  MESSAGE_LINKS_ASSERTION_RECORDS,
  MESSAGE_LINKS_LABELS,
  MESSAGE_LINKS_RUN_SUFFIX,
  MESSAGE_LINKS_STAGE_PROFILES,
  MESSAGE_LINKS_STAGES,
  OPEN_ROOM_LABEL,
  PORTRAIT_GEOMETRY_CHECKS,
  assertActionError,
  assertActiveRoom,
  assertAndroidUserCardDialog,
  assertApiLogin,
  assertAppliedMode,
  assertAaSuccessContrast,
  assertCoarseAndroidPointer,
  assertDialogNamesUser,
  assertDisplayName,
  assertEventId,
  assertExactPlaceholder,
  assertJoinRuleInvite,
  assertJoinSuccess,
  assertJoinedMembership,
  assertLeftMembership,
  assertLoadErrorVisible,
  assertMessageLinksReceiptName,
  assertMessageLinksRecords,
  assertModeOnlyChange,
  assertNoAnchoredPopover,
  assertNoNavigation,
  assertNoPrimaryAction,
  assertNotJoined,
  assertPhysicalFooterReach,
  assertPreviewClosed,
  assertPreviewName,
  assertPreviewTopic,
  assertPreviewVisible,
  assertPrimaryAction,
  assertRejectedJoinState,
  assertRemoteRoom,
  assertRemoteUserId,
  assertRoomLinkPreview,
  assertRoomRoute,
  assertSentEvent,
  assertSheetClass,
  assertSingleLinkAnchor,
  assertSourceStillActive,
  assertUnavailableGuidance,
  assertViewportFit,
  contrastRatio,
  joinedPreviewMessage,
  mentionMessage,
  messageLinksAssertion,
  messageLinksHrefs,
  messageLinksNames,
  messageLinksProfileDigest,
  messageLinksProfiles,
  parseNavigationBarFrame,
  parseWmSize,
  roomLinkMessage,
  type FormattedMessage,
  type LinkTarget,
  type MembershipObservation,
  type MessageLinksAssertion,
  type MessageLinksMode,
  type MessageLinksProfileName,
  type MessageLinksStage,
  type MessageLinksStageId,
  type PhysicalFooterReachReceipt,
  type RoomIdentity,
  type RoomLinkPrimaryLabel,
} from './message-links-contract.mts';
import {
  MessageLinksHttpError,
  createMessageLinksFixtures,
  readSecondary,
  type MessageLinksFixtures,
  type RemoteAccount,
  type SecondaryDescriptor,
} from './message-links-fixtures.mts';
import {
  readAppliedMode,
  readAppliedProfile,
  readComposerPlaceholder,
  readLinkAnchors,
  readNavigationMarker,
  readPortraitSheetGeometry,
  readRoomLinkPreview,
  readSuccessContrast,
  readUserCardDialogModel,
  stableSample,
  type AppearanceModeId,
  type AppliedModeObservation,
  type AppliedProfileObservation,
  type ComposerPlaceholderObservation,
  type LinkAnchorObservation,
  type RoomLinkPreviewObservation,
} from './message-links-observer.mts';
import {
  markMessageLinksDiagnosticsSafe,
  messageLinksSecrets,
  revokeMessageLinksPublicationOnAbort,
  runMessageLinksStageCleanup,
  scanMessageLinksArtifacts,
  scrubMessageLinksArtifacts,
  type MessageLinksPublicationSafety,
  type MessageLinksSecretAccount,
  type MessageLinksSecretRoom,
  redactSecretText,
} from './message-links-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const PRIMARY = '[data-testid="room-link-primary"]';
const PREVIEW_CLOSE = '[data-testid="room-link-close"]';
const USER_CARD = '[data-testid="user-card"]';
const USER_CARD_NAME = '[data-testid="user-card-name"]';
const SETTINGS_SECTIONS = '[aria-label="Settings sections"]';
const SETTINGS_DETAIL = '[data-testid="settings-detail"]';

// Polling bounds (design D8): each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const PREVIEW_MS = 30_000;
const ACTION_MS = 45_000;
const NAVIGATION_MS = 30_000;
const CARD_MS = 30_000;
const SYNC_MS = 30_000;
const SETTINGS_MS = 30_000;
const MODE_MS = 15_000;
const OBSERVE_MS = 15_000;
const REST_PACE_MS = 500;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageLinksStage;
  readonly records: MessageLinksAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** Every identifier a stage creates, registered before any UI step. */
export interface MessageLinksSecretLedger {
  readonly run: string;
  local?: MessageLinksSecretAccount;
  remote?: MessageLinksSecretAccount;
  bob?: MessageLinksSecretAccount;
  bobName?: string;
  readonly rooms: Record<string, MessageLinksSecretRoom>;
  readonly hrefs: string[];
  readonly eventIds: string[];
}

export interface MessageLinksStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly base: AccountFixtures;
  readonly links: MessageLinksFixtures;
  readonly secondary: SecondaryDescriptor;
  readonly secrets: Record<string, string>;
  readonly safety: MessageLinksPublicationSafety;
  readonly ledger: MessageLinksSecretLedger;
  /** Set once `client.reset` has attached a WebView that can be captured. */
  native: boolean;
}

/** Native helpers only need the client and the receipt counter. */
type NativeContext = Pick<MessageLinksStageContext, 'client' | 'receipts'>;

/** A parity identity is emitted only after its proof passed, in contract order. */
export async function record(
  context: RecordContext,
  suffix: string,
  assertion: () => void,
  observation: unknown,
): Promise<void> {
  const identity = messageLinksAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-links parity records stay in source order');
  assert(!context.identities.has(identity), 'No duplicate suite assertion identity');
  assertion();
  await context.client.record(identity, { assertion: identity, observation });
  context.records.push(identity);
  context.identities.add(identity);
}

/** A numbered, artifact-local proof that is never a parity identity. */
export async function receipt(
  context: Pick<RecordContext, 'client' | 'receipts'>,
  name: string,
  value: unknown,
): Promise<void> {
  assertMessageLinksReceiptName(name);
  context.receipts++;
  await context.client.record(
    `receipt-${String(context.receipts).padStart(2, '0')}-${name}`, value);
}

function passes<T>(check: (value: T) => void): (value: T) => boolean {
  return (value) => {
    try {
      check(value);
      return true;
    } catch {
      return false;
    }
  };
}

/** Space REST polling so a bounded wait does not flood either homeserver. */
function paced<T>(read: () => Promise<T>, signal: AbortSignal): () => Promise<T> {
  let first = true;
  return async () => {
    if (!first) await delay(REST_PACE_MS, undefined, { signal });
    first = false;
    return read();
  };
}

/** Merge identifiers into the stage ledger and register every form as a secret. */
function protect(
  context: MessageLinksStageContext,
  patch: {
    readonly local?: MessageLinksSecretAccount;
    readonly remote?: MessageLinksSecretAccount;
    readonly bob?: MessageLinksSecretAccount;
    readonly bobName?: string;
    readonly rooms?: Readonly<Record<string, MessageLinksSecretRoom>>;
    readonly hrefs?: readonly string[];
    readonly eventIds?: readonly string[];
  },
): void {
  const { ledger } = context;
  if (patch.local) ledger.local = patch.local;
  if (patch.remote) ledger.remote = patch.remote;
  if (patch.bob) ledger.bob = patch.bob;
  if (patch.bobName !== undefined) ledger.bobName = patch.bobName;
  for (const [role, room] of Object.entries(patch.rooms ?? {}))
    ledger.rooms[role] = { ...ledger.rooms[role], ...room };
  ledger.hrefs.push(...(patch.hrefs ?? []));
  ledger.eventIds.push(...(patch.eventIds ?? []));
  Object.assign(context.secrets, messageLinksSecrets(context.entry.id, ledger));
}

/** Every identifier is registered: native UI may now start. */
function sealSecrets(context: MessageLinksStageContext): void {
  Object.assign(context.secrets, messageLinksSecrets(context.entry.id, context.ledger));
  context.safety.unsafeSecrets = false;
}

const roomIdentity = (
  room: { readonly id: string; readonly name: string },
  account: { readonly userId: string },
): RoomIdentity => ({ name: room.name, roomId: room.id, userId: account.userId });

// Native helpers. Maestro owns every product action; the renderer only observes.

/** Reset to the stage profile and write `profile-applied.json`. */
async function startNative(
  context: MessageLinksStageContext,
): Promise<AppliedProfileObservation> {
  assert(!context.safety.unsafeSecrets,
    'Every stage identifier is registered before any UI step');
  const { client, entry } = context;
  await client.reset(entry.profile);
  context.native = true;
  const applied = await readAppliedProfile(client);
  await client.record('profile-applied', {
    profile: MESSAGE_LINKS_STAGE_PROFILES[entry.id],
    requested: entry.profile,
    digest: messageLinksProfileDigest(entry.profile),
    ...applied,
  });
  return applied;
}

/** Tap the rail and the exact Room row, then prove the exact composer and route. */
export async function openRoom(
  context: MessageLinksStageContext,
  room: RoomIdentity,
  suffix?: string,
): Promise<ComposerPlaceholderObservation> {
  const { client } = context;
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, ROOM_OPEN_MS);
  await client.tapCurrent('.channel', { text: room.name });
  const composer = await client.visible(COMPOSER, {}, ROOM_OPEN_MS);
  const active = await readComposerPlaceholder(client, {
    accepts: passes((value) => assertActiveRoom(value, room)),
    description: 'exact composer placeholder and Room route after native open',
    timeoutMs: NAVIGATION_MS,
  });
  assertActiveRoom(active, room);
  await receipt(context, 'room-open-route', {
    exactPlaceholder: true,
    exactRoute: true,
    roomDigest: digest(room.roomId),
  });
  if (suffix !== undefined) {
    await record(context, suffix, () => {
      assert(composer.visible, 'The composer is visible after native open');
      assertExactPlaceholder(active, room.name);
    }, { composerVisible: composer.visible, count: active.count });
  }
  return active;
}

export interface MessageLinkExpectation {
  readonly target: LinkTarget;
  /** Accepted verbatim hrefs; the first is the sent href. */
  readonly hrefs: readonly string[];
}

/** Prove one exact, unobstructed message link, then tap it natively. */
export async function tapMessageLink(
  context: NativeContext,
  label: string,
  expected: MessageLinkExpectation,
): Promise<LinkAnchorObservation> {
  const { client } = context;
  const check = (value: Parameters<typeof assertSingleLinkAnchor>[0]): LinkAnchorObservation => {
    const anchor = assertSingleLinkAnchor(value, label, expected.target);
    assert(anchor.href !== null && expected.hrefs.includes(anchor.href),
      'The message link href is an accepted form of the sent href');
    return anchor;
  };
  const anchors = await readLinkAnchors(client, label, {
    accepts: passes(check),
    description: `one exact message link reading ${label}`,
    timeoutMs: PREVIEW_MS,
  });
  const anchor = check(anchors);
  const physical = await client.nativeRect(anchor.rect);
  await receipt(context, 'link-anchor', {
    label,
    hrefForm: expected.hrefs.indexOf(anchor.href!),
    targetKind: expected.target.kind,
    via: expected.target.via.length,
    cssRect: anchor.rect,
    physicalRect: physical,
  });
  await client.tapCurrent('.scroll a', { exactText: label });
  return anchor;
}

async function awaitPreview(
  client: AccountWorkspaceClient,
  check: (preview: RoomLinkPreviewObservation) => void,
  description: string,
  timeoutMs = OBSERVE_MS,
): Promise<RoomLinkPreviewObservation> {
  const preview = await readRoomLinkPreview(client, {
    accepts: passes(check),
    description,
    timeoutMs,
  });
  check(preview);
  return preview;
}

/** Tap the settled primary action natively; focus is only ever observed. */
export async function tapPreviewPrimary(
  context: NativeContext,
  label: RoomLinkPrimaryLabel,
): Promise<RoomLinkPreviewObservation> {
  const before = await awaitPreview(context.client,
    (preview) => assertPrimaryAction(preview, label),
    `settled ${label} primary before its native tap`);
  // Read-only actionability receipt: which gate (count, visibility, disabled,
  // viewport or occlusion) the native tap will face, recorded before the tap.
  await receipt(context, 'primary-actionability', await evaluateNative(context.client.webview, `(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(PRIMARY)})];
    const box = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { x: r.x, y: r.y, width: r.width, height: r.height, position: style.position,
        transform: style.transform, className: typeof element.className === 'string' ? element.className.slice(0, 160) : null };
    };
    const section = buttons[0]?.closest('section') ?? null;
    return {
      count: buttons.length,
      innerWidth, innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      visualViewport: visualViewport ? { width: visualViewport.width, height: visualViewport.height,
        offsetLeft: visualViewport.offsetLeft, pageLeft: visualViewport.pageLeft, scale: visualViewport.scale } : null,
      screen: { width: screen.width, height: screen.height },
      scroll: { x: scrollX, y: scrollY },
      devicePixelRatio,
      section: box(section),
      pane: box(buttons[0]?.closest('.cdk-overlay-pane') ?? null),
      wrapper: box(buttons[0]?.closest('.cdk-global-overlay-wrapper') ?? null),
      container: box(document.querySelector('.cdk-overlay-container')),
      buttons: buttons.map((button) => {
        const r = button.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          disabled: button.matches(':disabled'),
          visibility: getComputedStyle(button).visibility,
          centreInViewport: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
          hitInside: button.contains(hit),
          hitTag: hit ? hit.tagName.toLowerCase() : null,
          hitClass: hit && typeof hit.className === 'string' ? hit.className.slice(0, 120) : null,
        };
      }),
    };
  })()`));
  await context.client.tapCurrent(PRIMARY);
  await receipt(context, 'primary-tapped', { label });
  return before;
}

/** Close the preview with its header Close button and prove it is gone. */
export async function closePreview(context: NativeContext): Promise<void> {
  await context.client.tapCurrent(PREVIEW_CLOSE);
  const closed = await awaitPreview(context.client, assertPreviewClosed,
    'room-link preview closed after native Close');
  await receipt(context, 'preview-closed', { count: closed.count });
}

export interface AppearanceSelection {
  readonly mode: MessageLinksMode;
  /** The checked radio observed while Settings rendered it. */
  readonly checkedMode: AppearanceModeId | null;
  readonly baseline: AppliedModeObservation;
  readonly applied: AppliedModeObservation;
}

const carriers = (mode: AppliedModeObservation): Readonly<Record<string, unknown>> => ({
  htmlDark: mode.htmlDark,
  theme: mode.theme,
  density: mode.density,
  codeLines: mode.codeLines,
  inlineFontSize: mode.inlineFontSize,
  codeScale: mode.codeScale,
});

/**
 * D7: mode-only Appearance selection through Settings test-id taps and the in-app
 * header Back. No hardware Back, shortcut flow, preference seed or class write.
 */
export async function selectAppearanceMode(
  context: NativeContext,
  mode: MessageLinksMode,
  returnHref?: string,
): Promise<AppearanceSelection> {
  const { client } = context;
  const baseline = await readAppliedMode(client);
  const before = (await client.surface()).url;
  if (returnHref !== undefined)
    assert.equal(before, returnHref, 'Appearance round trip starts on the expected route');
  await receipt(context, `appearance-${mode}-baseline`, {
    ...carriers(baseline),
    checkedMode: baseline.checkedMode,
    startsOnExpectedRoute: returnHref === undefined ? null : true,
  });

  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible(SETTINGS_SECTIONS, {}, SETTINGS_MS);
  await receipt(context, `appearance-${mode}-settings-open`, { sections: true });

  await client.tapCurrent('[data-testid="settings-nav-appearance"]');
  const section = await waitForNativeShellState(
    () => client.surface(),
    (surface) => new URL(surface.url).pathname === '/settings/appearance',
    'Appearance settings route after the native section tap',
    client.signal,
    SETTINGS_MS,
  );
  await client.visible(SETTINGS_DETAIL, {}, SETTINGS_MS);
  await receipt(context, `appearance-${mode}-section`, {
    pathname: new URL(section.url).pathname,
    detail: true,
  });

  const control = `[data-testid="mode-${mode}"]`;
  await client.scrollIntoViewIfNeeded(control, SETTINGS_DETAIL);
  // Hydration disables the radios until the stored Appearance is read.
  await client.waitElements(`${control} input:not(:disabled)`,
    (inputs) => inputs.length === 1, `hydrated ${mode} mode radio`, {}, MODE_MS);
  await receipt(context, `appearance-${mode}-control-ready`, { enabled: true });

  await client.tapCurrent(`[data-testid="mode-${mode}"]`);
  const applied = await readAppliedMode(client, {
    accepts: passes((value) => assertModeOnlyChange(baseline, value, mode)),
    description: `mode-only ${mode} Appearance selection`,
    timeoutMs: MODE_MS,
  });
  assertModeOnlyChange(baseline, applied, mode);
  await receipt(context, `appearance-${mode}-applied`, {
    ...carriers(applied),
    checkedMode: applied.checkedMode,
    checkedCount: applied.checkedCount,
    modeOnly: true,
  });

  await client.tapCurrent('trn-page-header button[aria-label="Back"]');
  await waitForNativeShellState(
    () => client.surface(),
    (surface) => surface.url === before,
    'in-app header Back to the exact prior route',
    client.signal,
    SETTINGS_MS,
  );
  const settled = await readAppliedMode(client, {
    accepts: passes((value) => assertAppliedMode(value, mode, false)),
    description: `${mode} Appearance retained after the header Back`,
    timeoutMs: OBSERVE_MS,
  });
  assertAppliedMode(settled, mode, false);
  await receipt(context, `appearance-${mode}-returned`, {
    exactPriorRoute: true,
    htmlDark: settled.htmlDark,
  });
  return { mode, checkedMode: applied.checkedMode, baseline, applied };
}

// Fixture helpers that emit the predecessor's helper-owned identities.

async function readRoomName(
  context: MessageLinksStageContext,
  account: NodeWorkspaceAccount,
  roomId: string,
): Promise<unknown> {
  return (await context.base.roomState(account, roomId, 'm.room.name'))?.['name'];
}

/** `localScenario` (103–122): API login (37@118) and the source Room (76@120). */
async function arrangeLocalScenario(
  context: MessageLinksStageContext,
  role: string,
): Promise<{
  readonly local: NodeWorkspaceAccount;
  readonly source: { readonly id: string; readonly name: string };
}> {
  const { base, links, ledger } = context;
  const sourceName = messageLinksNames.sourceRoom(ledger.run);
  protect(context, { rooms: { source: { name: sourceName } } });
  const local = await base.account(role);
  protect(context, { local });
  const login = await links.apiLogin(local);
  await record(context, 'api-login', () => assertApiLogin(login, local.userId), {
    userMatches: login.userId === local.userId,
  });
  const source = await base.createRoom(local, { name: sourceName });
  protect(context, { rooms: { source: { id: source.id } } });
  const readBack = await readRoomName(context, local, source.id);
  await record(context, 'source-room-created', () => {
    assert(source.id.startsWith('!'), 'Source Room has a Room id');
    assert.equal(readBack, sourceName, 'Source Room name read back exactly');
  }, { roomDigest: digest(source.id), nameReadBack: readBack === sourceName });
  return { local, source };
}

/** `sendRoomLink` (86–101) plus an exact event read-back. */
async function sendLink(
  context: MessageLinksStageContext,
  local: NodeWorkspaceAccount,
  sourceId: string,
  href: string,
  label: string,
): Promise<string> {
  protect(context, { hrefs: [href] });
  const sent = await context.links.sendRoomLink(local, sourceId, href, label,
    messageLinksNames.linkTxn(context.ledger.run));
  protect(context, { eventIds: [sent.eventId] });
  const expected = roomLinkMessage(href, label);
  const event = await context.links.event(local, sourceId, sent.eventId);
  await record(context, 'link-sent', () => {
    assertEventId(sent.eventId);
    assertSentEvent(event, expected);
  }, { eventDigest: digest(sent.eventId), exactFormattedBody: true });
  return sent.eventId;
}

/** A formatted send whose content is a receipt, not a parity identity. */
async function sendFormattedReceipt(
  context: MessageLinksStageContext,
  account: NodeWorkspaceAccount,
  roomId: string,
  content: FormattedMessage,
  txnId: string,
): Promise<void> {
  const sent = await context.links.sendFormatted(account, roomId, content, txnId);
  protect(context, { eventIds: [sent.eventId] });
  const event = await context.links.event(account, roomId, sent.eventId);
  assertEventId(sent.eventId);
  assertSentEvent(event, content);
  await receipt(context, 'formatted-sent', {
    eventDigest: digest(sent.eventId),
    exactFormattedBody: true,
  });
}

/** Register the expected remote id before `registerRemote` can return it. */
function protectRemote(context: MessageLinksStageContext, localpart: string): void {
  protect(context, {
    remote: { userId: `@${localpart}:${context.secondary.serverName}`, localpart },
  });
}

/** `registerRemote` (44–59): the secondary returned the exact remote user. */
async function recordRemoteRegistered(
  context: MessageLinksStageContext,
  localpart: string,
  remote: RemoteAccount,
): Promise<void> {
  protect(context, { remote });
  await record(context, 'remote-registered',
    () => assertRemoteUserId(remote.userId, localpart, context.secondary.serverName),
    { secondaryUser: true });
}

async function readMembership(
  context: MessageLinksStageContext,
  remote: RemoteAccount,
  roomId: string,
  local: NodeWorkspaceAccount,
): Promise<MembershipObservation> {
  return {
    secondary: await context.links.remoteMembership(remote, roomId, local.userId),
    primaryJoined: await context.base.joinedRoomIds(local),
  };
}

async function awaitMembership(
  context: MessageLinksStageContext,
  remote: RemoteAccount,
  roomId: string,
  local: NodeWorkspaceAccount,
  check: (membership: MembershipObservation) => void,
  description: string,
): Promise<MembershipObservation> {
  const membership = await waitForNativeShellState(
    paced(() => readMembership(context, remote, roomId, local), context.client.signal),
    passes(check),
    description,
    context.client.signal,
    SYNC_MS,
  );
  check(membership);
  return membership;
}

const membershipSummary = (
  membership: MembershipObservation,
  roomId: string,
): Readonly<Record<string, unknown>> => ({
  secondary: membership.secondary,
  primaryJoined: membership.primaryJoined.includes(roomId),
});

/** The local user's native Join of a remote Room. */
export interface NativeJoin {
  readonly local: NodeWorkspaceAccount;
  readonly remote: RemoteAccount;
  readonly roomId: string;
}

/** What a failed Join window needs to read both servers and hand over cleanup. */
export interface JoinCleanupContext {
  readonly base: Pick<AccountFixtures,
    'joinedRoomIds' | 'trackRoomMembership' | 'allowEndedMembershipCleanup'>;
  readonly links: Pick<MessageLinksFixtures, 'remoteMembership'>;
}

/**
 * Run a native Join tap and the proofs that follow it. When any of them fails, one
 * bounded read of both servers, on its own timeout, decides whether the Join landed
 * anyway. A landed Join, or one no read could rule out, is handed to the base
 * cleanup, which then leaves and forgets the Room (design D1). The Room is never
 * tracked before the tap: a leave of a Room the user never joined fails outside the
 * ended-membership tolerance.
 */
export async function afterJoinTap<T>(
  context: JoinCleanupContext,
  join: NativeJoin,
  tapAndProve: () => Promise<T>,
): Promise<T> {
  try {
    return await tapAndProve();
  } catch (error) {
    const signal = AbortSignal.timeout(SYNC_MS);
    const reads = await Promise.allSettled([
      context.links.remoteMembership(join.remote, join.roomId, join.local.userId, signal),
      context.base.joinedRoomIds(join.local, signal),
    ]);
    const [secondary, primary] = reads;
    const unread = reads.flatMap((read) => read.status === 'rejected' ? [read.reason] : []);
    const landed = (secondary.status === 'fulfilled' && secondary.value === 'join') ||
      (primary.status === 'fulfilled' && primary.value.includes(join.roomId));
    if (landed || unread.length) {
      context.base.trackRoomMembership(join.local, join.roomId);
      context.base.allowEndedMembershipCleanup(join.local, join.roomId);
    }
    if (!unread.length) throw error;
    throw new AggregateError([error, ...unread],
      'Android message-links Join failed and its membership could not be read');
  }
}

async function stableContrast(
  context: NativeContext,
  mode: MessageLinksMode,
): Promise<Awaited<ReturnType<typeof readSuccessContrast>>> {
  return stableSample(() => readSuccessContrast(context.client), {
    signal: context.client.signal,
    description: `${mode} room-link success contrast`,
  });
}

// Stage 1: a joined room previews before an explicit Open (156–230).

export async function runJoinedPreview(context: MessageLinksStageContext): Promise<void> {
  const { client, base, links, ledger } = context;
  const sourceName = messageLinksNames.sourceRoom(ledger.run);
  const targetName = messageLinksNames.targetRoom(ledger.run);
  protect(context, { rooms: { source: { name: sourceName }, target: { name: targetName } } });
  const local = await base.account('ml-joined');
  protect(context, { local });
  const login = await links.apiLogin(local);
  assertApiLogin(login, local.userId);
  await receipt(context, 'api-login', { userMatches: true });
  const source = await base.createRoom(local, { name: sourceName });
  protect(context, { rooms: { source: { id: source.id } } });
  const target = await base.createRoom(local, { name: targetName });
  protect(context, { rooms: { target: { id: target.id } } });
  assert.equal(await readRoomName(context, local, source.id), sourceName,
    'Source Room name read back exactly');
  assert.equal(await readRoomName(context, local, target.id), targetName,
    'Target Room name read back exactly');
  await receipt(context, 'rooms-created', { source: true, target: true });
  const href = messageLinksHrefs.joinedTarget(target.id);
  protect(context, { hrefs: [href] });
  await sendFormattedReceipt(context, local, source.id,
    joinedPreviewMessage(targetName, target.id), messageLinksNames.linkTxn(ledger.run));
  sealSecrets(context);

  await startNative(context);
  await client.login(local);
  await client.hideKeyboard();
  const sourceRoom = roomIdentity(source, local);
  const targetRoom = roomIdentity(target, local);
  const before = await openRoom(context, sourceRoom, 'room-open');

  const label = MESSAGE_LINKS_LABELS['joined-preview'];
  await tapMessageLink(context, label, {
    target: { kind: 'room', target: target.id, via: [] },
    hrefs: [href],
  });
  const visible = await awaitPreview(client, assertPreviewVisible,
    'visible room-link preview');
  await record(context, 'preview-visible', () => assertPreviewVisible(visible), {
    count: visible.count, visible: visible.visible,
  });
  const named = await awaitPreview(client,
    (preview) => assertPreviewName(preview, targetName),
    'exact joined target name', PREVIEW_MS);
  await record(context, 'target-name', () => assertPreviewName(named, targetName), {
    exactName: true,
  });
  const open = await awaitPreview(client,
    (preview) => assertPrimaryAction(preview, OPEN_ROOM_LABEL),
    'Open room primary for a joined target');
  await record(context, 'open-action',
    () => assertPrimaryAction(open, OPEN_ROOM_LABEL),
    { primary: open.primary.text });
  const after = await readComposerPlaceholder(client);
  await record(context, 'source-still-active',
    () => assertSourceStillActive(before, after, sourceRoom),
    { exactPlaceholder: true, routeUnchanged: after.href === before.href });

  await tapPreviewPrimary(context, OPEN_ROOM_LABEL);
  const opened = await readComposerPlaceholder(client, {
    accepts: passes((value) => assertActiveRoom(value, targetRoom)),
    description: 'target Room placeholder and route after native Open',
    timeoutMs: NAVIGATION_MS,
  });
  const closed = await awaitPreview(client, assertPreviewClosed,
    'room-link preview closed after Open');
  await record(context, 'target-opened', () => {
    assertActiveRoom(opened, targetRoom);
    assertPreviewClosed(closed);
  }, { exactPlaceholder: true, exactRoute: true, previewCount: closed.count });
}

// Stage 2: previews and joins a public room across real federation (232–321).

export async function runFederatedJoin(context: MessageLinksStageContext): Promise<void> {
  const { client, base, links, ledger, secondary } = context;
  const run = ledger.run;
  const { local, source } = await arrangeLocalScenario(context, 'ml-federated');
  const remoteLocalpart = messageLinksNames.federatedRemote(run);
  protectRemote(context, remoteLocalpart);
  const remote = await links.registerRemote(remoteLocalpart);
  await recordRemoteRegistered(context, remoteLocalpart, remote);
  const remoteName = messageLinksNames.federatedRoom(run);
  const remoteTopic = messageLinksNames.federatedTopic(secondary.serverName);
  const aliasLocalpart = messageLinksNames.federatedAliasLocalpart(run);
  const alias = messageLinksNames.alias(aliasLocalpart, secondary.serverName);
  protect(context, {
    rooms: { remote: { name: remoteName, topic: remoteTopic, alias, aliasLocalpart } },
  });
  const remoteRoom = await links.createRemoteRoom(remote, {
    name: remoteName,
    topic: remoteTopic,
    preset: 'public_chat',
    visibility: 'public',
    aliasLocalpart,
  });
  protect(context, { rooms: { remote: { id: remoteRoom.id } } });
  await record(context, 'remote-room-created', () => assertRemoteRoom(remoteRoom, {
    name: remoteName, topic: remoteTopic, joinRule: 'public', alias, published: true,
  }), {
    exactName: true, exactTopic: true, joinRule: remoteRoom.joinRule,
    aliasResolves: true, published: remoteRoom.published,
  });
  const href = messageLinksHrefs.federatedAlias(alias);
  await sendLink(context, local, source.id, href, MESSAGE_LINKS_LABELS['federated-join']);
  const aliasProbe = await links.awaitAliasFederation(local, alias, remoteRoom.id);
  await receipt(context, 'federation-alias', aliasProbe);
  sealSecrets(context);

  await startNative(context);
  await client.login(local);
  await client.hideKeyboard();
  const light = await selectAppearanceMode(context, 'light');
  const sourceRoom = roomIdentity(source, local);
  const before = await openRoom(context, sourceRoom, 'room-open');
  const label = MESSAGE_LINKS_LABELS['federated-join'];
  const expected: MessageLinkExpectation = {
    target: { kind: 'room', target: alias, via: [] },
    hrefs: [href],
  };
  await tapMessageLink(context, label, expected);

  const named = await awaitPreview(client,
    (preview) => assertPreviewName(preview, remoteName),
    'exact federated Room name', PREVIEW_MS);
  await record(context, 'remote-name', () => assertPreviewName(named, remoteName), {
    exactName: true,
  });
  const topic = await awaitPreview(client,
    (preview) => assertPreviewTopic(preview, remoteTopic), 'exact federated Room topic');
  await record(context, 'remote-topic', () => assertPreviewTopic(topic, remoteTopic), {
    exactTopic: true,
  });
  assert.equal(topic.address, alias, 'The preview shows the exact alias');
  await receipt(context, 'remote-address', { exactAddress: true });
  const joinable = await awaitPreview(client,
    (preview) => assertPrimaryAction(preview, JOIN_ROOM_LABEL),
    'Join room primary for the federated Room', PREVIEW_MS);
  await record(context, 'join-action',
    () => assertPrimaryAction(joinable, JOIN_ROOM_LABEL),
    { primary: joinable.primary.text });
  const after = await readComposerPlaceholder(client);
  await record(context, 'source-still-active',
    () => assertSourceStillActive(before, after, sourceRoom),
    { exactPlaceholder: true, routeUnchanged: after.href === before.href });

  // First real Join, measured under Light. Until membership proof #1 tracks it, a
  // failure still hands a Join that landed to the base cleanup.
  const join: NativeJoin = { local, remote, roomId: remoteRoom.id };
  const firstMembership = await afterJoinTap(context, join, async () => {
    await tapPreviewPrimary(context, JOIN_ROOM_LABEL);
    const joined = await awaitPreview(client, (preview) => assertJoinSuccess(preview),
      'Room joined success notice', ACTION_MS);
    await record(context, 'joined-notice', () => assertJoinSuccess(joined), {
      success: joined.success.count,
    });
    assertJoinSuccess(joined, true);
    await receipt(context, 'joined-notice-exact', { exactSuccessText: true });
    const openable = await awaitPreview(client,
      (preview) => assertPrimaryAction(preview, OPEN_ROOM_LABEL),
      'Open room primary after the federated Join');
    await record(context, 'open-action',
      () => assertPrimaryAction(openable, OPEN_ROOM_LABEL),
      { primary: openable.primary.text });
    await client.focused(PRIMARY);
    const focused = await readRoomLinkPreview(client);
    await record(context, 'open-focused',
      () => assertPrimaryAction(focused, OPEN_ROOM_LABEL, true),
      { focused: focused.primary.focused });
    return awaitMembership(context, remote, remoteRoom.id, local,
      (membership) => assertJoinedMembership(membership, remoteRoom.id),
      'first federated join on both servers');
  });
  base.trackRoomMembership(local, remoteRoom.id);
  base.allowEndedMembershipCleanup(local, remoteRoom.id);
  await receipt(context, 'membership-1',
    membershipSummary(firstMembership, remoteRoom.id));
  const lightContrast = await stableContrast(context, 'light');
  await record(context, 'light-contrast',
    () => assertAaSuccessContrast(lightContrast, 'light', light.checkedMode), {
    ratio: contrastRatio(lightContrast.foreground, lightContrast.background),
    htmlDark: lightContrast.htmlDark,
    selectedMode: light.checkedMode,
    foreground: lightContrast.foreground,
    background: lightContrast.background,
    layers: lightContrast.layers,
  });

  // Reset the success state: close, leave on the server, prove the leave everywhere.
  await closePreview(context);
  await links.leaveLocal(local, remoteRoom.id);
  const left = await waitForNativeShellState(
    paced(async () => ({
      membership: await readMembership(context, remote, remoteRoom.id, local),
      sidebarRows: (await client.elements('.channel', { text: remoteName })).length,
    }), client.signal),
    passes((value) => assertLeftMembership(value.membership, remoteRoom.id,
      value.sidebarRows)),
    'federated leave on both servers and in the sidebar',
    client.signal,
    SYNC_MS,
  );
  assertLeftMembership(left.membership, remoteRoom.id, left.sidebarRows);
  await receipt(context, 'leave-sync', {
    ...membershipSummary(left.membership, remoteRoom.id),
    sidebarRows: left.sidebarRows,
  });

  // Second real Join of the same Room, measured under Dark.
  const dark = await selectAppearanceMode(context, 'dark', before.href);
  await tapMessageLink(context, label, expected);
  const rejoinable = await awaitPreview(client, (preview) => assertRoomLinkPreview(preview, {
    name: remoteName, topic: remoteTopic, address: alias, primary: JOIN_ROOM_LABEL,
  }), 'same federated preview offering Join room after the leave', PREVIEW_MS);
  await receipt(context, 'rejoin-preview', {
    exactName: true, exactTopic: true, primary: rejoinable.primary.text,
  });
  await tapPreviewPrimary(context, JOIN_ROOM_LABEL);
  const rejoined = await awaitPreview(client, (preview) => assertJoinSuccess(preview, true),
    'exact success notice after the second Join', ACTION_MS);
  const reopenable = await awaitPreview(client,
    (preview) => assertPrimaryAction(preview, OPEN_ROOM_LABEL),
    'Open room primary after the second Join');
  await client.focused(PRIMARY);
  const refocused = await readRoomLinkPreview(client);
  assertPrimaryAction(refocused, OPEN_ROOM_LABEL, true);
  await receipt(context, 'rejoin-success', {
    exactSuccessText: rejoined.success.count === 1,
    primary: reopenable.primary.text,
    focused: refocused.primary.focused,
  });
  const secondMembership = await awaitMembership(context, remote, remoteRoom.id, local,
    (membership) => assertJoinedMembership(membership, remoteRoom.id),
    'second federated join on both servers');
  await receipt(context, 'membership-2',
    membershipSummary(secondMembership, remoteRoom.id));
  const darkContrast = await stableContrast(context, 'dark');
  await record(context, 'dark-contrast',
    () => assertAaSuccessContrast(darkContrast, 'dark', dark.checkedMode), {
    ratio: contrastRatio(darkContrast.foreground, darkContrast.background),
    htmlDark: darkContrast.htmlDark,
    selectedMode: dark.checkedMode,
    foreground: darkContrast.foreground,
    background: darkContrast.background,
    layers: darkContrast.layers,
  });

  await tapPreviewPrimary(context, OPEN_ROOM_LABEL);
  const remoteActive = roomIdentity(remoteRoom, local);
  const opened = await readComposerPlaceholder(client, {
    accepts: passes((value) => assertActiveRoom(value, remoteActive)),
    description: 'federated Room placeholder and route after native Open',
    timeoutMs: NAVIGATION_MS,
  });
  const finalMembership = await awaitMembership(context, remote, remoteRoom.id, local,
    (membership) => assertJoinedMembership(membership, remoteRoom.id),
    'federated membership after Open');
  await record(context, 'remote-opened', () => {
    assertActiveRoom(opened, remoteActive);
    assertJoinedMembership(finalMembership, remoteRoom.id);
  }, {
    exactPlaceholder: true,
    exactRoute: true,
    ...membershipSummary(finalMembership, remoteRoom.id),
  });
}

// Stage 3: a useful unavailable state for an inaccessible remote room (323–362).

export async function runRemoteUnavailable(
  context: MessageLinksStageContext,
): Promise<void> {
  const { client, links, ledger, secondary } = context;
  const run = ledger.run;
  const { local, source } = await arrangeLocalScenario(context, 'ml-unavailable');
  const remoteLocalpart = messageLinksNames.privateRemote(run);
  protectRemote(context, remoteLocalpart);
  const remote = await links.registerRemote(remoteLocalpart);
  await recordRemoteRegistered(context, remoteLocalpart, remote);
  const remoteName = messageLinksNames.privateRoom(run);
  protect(context, { rooms: { remote: { name: remoteName } } });
  const remoteRoom = await links.createRemoteRoom(remote, {
    name: remoteName, preset: 'private_chat',
  });
  protect(context, { rooms: { remote: { id: remoteRoom.id } } });
  await record(context, 'remote-room-created', () => assertRemoteRoom(remoteRoom, {
    name: remoteName, joinRule: 'invite', published: false,
  }), { exactName: true, joinRule: remoteRoom.joinRule, published: remoteRoom.published });
  const href = messageLinksHrefs.privateRemote(remoteRoom.id, secondary.serverName);
  await sendLink(context, local, source.id, href, MESSAGE_LINKS_LABELS['remote-unavailable']);
  const profileProbe = await links.awaitProfileFederation(local, remote.userId);
  await receipt(context, 'federation-profile', profileProbe);
  sealSecrets(context);

  await startNative(context);
  await client.login(local);
  await client.hideKeyboard();
  await openRoom(context, roomIdentity(source, local), 'room-open');
  await tapMessageLink(context, MESSAGE_LINKS_LABELS['remote-unavailable'], {
    target: { kind: 'room', target: remoteRoom.id, via: [secondary.serverName] },
    hrefs: [href],
  });
  const failed = await awaitPreview(client, assertLoadErrorVisible,
    'visible room-link load error', PREVIEW_MS);
  await record(context, 'load-error-visible', () => assertLoadErrorVisible(failed), {
    count: failed.loadError.count, visible: failed.loadError.visible,
  });
  await record(context, 'load-error-guidance', () => {
    assert.match(`${failed.loadError.title ?? ''} ${failed.loadError.message ?? ''}`,
      /Room (not found|unavailable)/, 'The load error names the unavailable Room');
  }, { title: failed.loadError.title });
  assertUnavailableGuidance(failed);
  await receipt(context, 'unavailable-copy', {
    title: failed.loadError.title,
    message: failed.loadError.message,
    retryCount: failed.retryCount,
  });
  const inert = await awaitPreview(client, assertNoPrimaryAction,
    'no primary action for an unavailable Room');
  await record(context, 'no-primary-action', () => assertNoPrimaryAction(inert), {
    primaryCount: inert.primary.count,
  });
  const membership = await readMembership(context, remote, remoteRoom.id, local);
  assertNotJoined(membership, remoteRoom.id);
  await receipt(context, 'membership-unjoined', membershipSummary(membership, remoteRoom.id));
}

// Stage 4: a rejected federated Join stays open and retryable (364–424).

export async function runRejectedJoin(context: MessageLinksStageContext): Promise<void> {
  const { client, links, ledger, secondary } = context;
  const run = ledger.run;
  const { local, source } = await arrangeLocalScenario(context, 'ml-rejected');
  const remoteLocalpart = messageLinksNames.retryRemote(run);
  protectRemote(context, remoteLocalpart);
  const remote = await links.registerRemote(remoteLocalpart);
  await recordRemoteRegistered(context, remoteLocalpart, remote);
  const remoteName = messageLinksNames.retryRoom(run);
  protect(context, { rooms: { remote: { name: remoteName } } });
  const remoteRoom = await links.createRemoteRoom(remote, {
    name: remoteName, preset: 'public_chat',
  });
  protect(context, { rooms: { remote: { id: remoteRoom.id } } });
  await record(context, 'remote-room-created', () => assertRemoteRoom(remoteRoom, {
    name: remoteName, joinRule: 'public', published: false,
  }), { exactName: true, joinRule: remoteRoom.joinRule, published: remoteRoom.published });
  const href = messageLinksHrefs.rejectedJoin(remoteRoom.id, secondary.serverName);
  // The renderer may present the `matrix:` URI or exactly its encoded matrix.to rewrite.
  const rewritten = messageLinksHrefs.rejectedJoinRendered(remoteRoom.id,
    secondary.serverName);
  protect(context, { hrefs: [rewritten] });
  await sendLink(context, local, source.id, href, MESSAGE_LINKS_LABELS['rejected-join']);
  const profileProbe = await links.awaitProfileFederation(local, remote.userId);
  await receipt(context, 'federation-profile', profileProbe);
  sealSecrets(context);

  await startNative(context);
  await client.login(local);
  await client.hideKeyboard();
  await openRoom(context, roomIdentity(source, local), 'room-open');
  await tapMessageLink(context, MESSAGE_LINKS_LABELS['rejected-join'], {
    target: { kind: 'room', target: remoteRoom.id, via: [secondary.serverName] },
    hrefs: [href, rewritten],
  });
  const joinable = await awaitPreview(client,
    (preview) => assertPrimaryAction(preview, JOIN_ROOM_LABEL),
    'Join room primary before the join-rule race', PREVIEW_MS);
  await record(context, 'join-action',
    () => assertPrimaryAction(joinable, JOIN_ROOM_LABEL),
    { primary: joinable.primary.text });
  assertPreviewName(joinable, remoteName);
  await receipt(context, 'race-preview', { exactName: true });

  // Change the rule only after the preview offered Join (404–413).
  const ruleChange = await links.setRemoteJoinRule(remote, remoteRoom.id, 'invite');
  await record(context, 'join-rule-invite', () => assertJoinRuleInvite(ruleChange), {
    status: ruleChange.status, readBack: ruleChange.readBack,
  });

  // The Join must fail. If a regression lets it land, the failed stage still hands
  // the membership to the base cleanup; a passing run never tracks this Room.
  await afterJoinTap(context, { local, remote, roomId: remoteRoom.id }, async () => {
    await tapPreviewPrimary(context, JOIN_ROOM_LABEL);
    const rejected = await awaitPreview(client, assertActionError,
      'visible room-link action error', ACTION_MS);
    await record(context, 'action-error', () => assertActionError(rejected), {
      count: rejected.actionError.count, visible: rejected.actionError.visible,
    });
    const retained = await awaitPreview(client,
      (preview) => assertPrimaryAction(preview, JOIN_ROOM_LABEL),
      'settled Join room primary after the rejected Join');
    await record(context, 'join-retained',
      () => assertPrimaryAction(retained, JOIN_ROOM_LABEL),
      { primary: retained.primary.text, ariaDisabled: retained.primary.ariaDisabled });
    await client.focused(PRIMARY);
    const focused = await readRoomLinkPreview(client);
    await record(context, 'join-focused',
      () => assertPrimaryAction(focused, JOIN_ROOM_LABEL, true),
      { focused: focused.primary.focused });
    const open = await readRoomLinkPreview(client);
    await record(context, 'preview-retained', () => assertPreviewName(open, remoteName), {
      count: open.count, visible: open.visible, exactName: open.name === remoteName,
    });
    const membership = await readMembership(context, remote, remoteRoom.id, local);
    // Re-read after the rejected Join: the rule must still be `invite`.
    const joinRule = await links.remoteJoinRule(remote, remoteRoom.id);
    assertRejectedJoinState({
      preview: open,
      name: remoteName,
      roomId: remoteRoom.id,
      membership,
      joinRule,
      tracked: false,
    });
    await receipt(context, 'rejected-join-state', {
      ...membershipSummary(membership, remoteRoom.id),
      joinRule,
      tracked: false,
    });
  });
}

// Stage 5: the portrait sheet and its action footer stay reachable (433–504).

export async function runPortraitSheet(context: MessageLinksStageContext): Promise<void> {
  const { client, base, ledger } = context;
  const { local, source } = await arrangeLocalScenario(context, 'ml-portrait');
  const targetName = messageLinksNames.portraitTarget(ledger.run);
  protect(context, { rooms: { target: { name: targetName } } });
  const target = await base.createRoom(local, { name: targetName });
  protect(context, { rooms: { target: { id: target.id } } });
  const readBack = await readRoomName(context, local, target.id);
  await record(context, 'target-room-created', () => {
    assert(target.id.startsWith('!'), 'Portrait target has a Room id');
    assert.equal(readBack, targetName, 'Portrait target name read back exactly');
  }, { roomDigest: digest(target.id), nameReadBack: readBack === targetName });
  const href = messageLinksHrefs.portraitTarget(target.id);
  await sendLink(context, local, source.id, href, MESSAGE_LINKS_LABELS['portrait-sheet']);
  sealSecrets(context);

  const applied = await startNative(context);
  const fitted = await readAppliedProfile(client, {
    accepts: (value) => value.innerWidth === context.entry.profile.width &&
      value.innerHeight === context.entry.profile.height,
    description: 'exact portrait viewport after reset',
    timeoutMs: OBSERVE_MS,
  });
  const fit = {
    innerWidth: fitted.innerWidth,
    innerHeight: fitted.innerHeight,
    devicePixelRatio: fitted.devicePixelRatio,
    orientationPortrait: fitted.orientationPortrait,
    nativeRect: await client.nativeRect({
      x: 0, y: 0, width: context.entry.profile.width, height: context.entry.profile.height,
    }),
  };
  assertViewportFit(fit);
  await receipt(context, 'viewport-fit', fit);
  await client.record('profile-applied', {
    profile: MESSAGE_LINKS_STAGE_PROFILES[context.entry.id],
    requested: context.entry.profile,
    digest: messageLinksProfileDigest(context.entry.profile),
    ...applied,
    fit,
  });
  await client.login(local);
  await client.hideKeyboard();
  await openRoom(context, roomIdentity(source, local), 'room-open');
  await tapMessageLink(context, MESSAGE_LINKS_LABELS['portrait-sheet'], {
    target: { kind: 'room', target: target.id, via: [] },
    hrefs: [href],
  });
  await client.hideKeyboard();

  const visible = await awaitPreview(client, assertPreviewVisible,
    'visible portrait room-link sheet');
  await record(context, 'preview-visible', () => assertPreviewVisible(visible), {
    count: visible.count, visible: visible.visible,
  });
  const sheet = await awaitPreview(client, assertSheetClass, 'phone sheet class');
  await record(context, 'sheet-class', () => assertSheetClass(sheet), {
    hostClasses: sheet.hostClasses,
  });
  const open = await awaitPreview(client,
    (preview) => assertPrimaryAction(preview, OPEN_ROOM_LABEL),
    'Open room primary in the portrait sheet');
  await record(context, 'open-action',
    () => assertPrimaryAction(open, OPEN_ROOM_LABEL),
    { primary: open.primary.text });

  const geometry = await stableSample(() => readPortraitSheetGeometry(client), {
    signal: client.signal,
    description: 'portrait sheet and footer geometry',
  });
  const replica = {
    portrait: geometry.portrait,
    surface: geometry.surface,
    footer: geometry.footer,
    viewportBottom: geometry.viewportBottom,
    viewportWidth: geometry.viewportWidth,
  };
  await record(context, 'portrait',
    () => PORTRAIT_GEOMETRY_CHECKS.portrait(geometry), replica);
  await record(context, 'left-edge',
    () => PORTRAIT_GEOMETRY_CHECKS['left-edge'](geometry), replica);
  await record(context, 'right-edge',
    () => PORTRAIT_GEOMETRY_CHECKS['right-edge'](geometry), replica);
  await record(context, 'bottom-edge',
    () => PORTRAIT_GEOMETRY_CHECKS['bottom-edge'](geometry), replica);

  // D3.4: map the footer buttons to physical pixels above the device navigation bar.
  assert.equal(geometry.primaryCount, 1, 'Exactly one footer primary action');
  assert.equal(geometry.closeCount, 1, 'Exactly one footer Close action');
  assert(geometry.rects.primary && geometry.rects.close, 'Footer buttons have boxes');
  const wmSize = await client.device.adb('shell', 'wm', 'size');
  const wmDensity = await client.device.adb('shell', 'wm', 'density');
  const windows = await client.device.adb('shell', 'dumpsys', 'window');
  const reach: PhysicalFooterReachReceipt = {
    navigationBar: parseNavigationBarFrame(windows, wmSize),
    footer: await client.nativeRect(geometry.rects.footer),
    primary: await client.nativeRect(geometry.rects.primary),
    close: await client.nativeRect(geometry.rects.close),
    primaryHit: geometry.primaryHit,
    closeHit: geometry.closeHit,
  };
  assertPhysicalFooterReach(reach);
  await receipt(context, 'physical-footer-reach', {
    ...reach,
    wmSize: parseWmSize(wmSize),
    wmDensity: wmDensity.trim(),
    footerPaddingBottom: geometry.footerPaddingBottom,
  });
  await record(context, 'footer-top', () => {
    PORTRAIT_GEOMETRY_CHECKS['footer-top'](geometry);
    assertPhysicalFooterReach(reach);
  }, { ...replica, physicalReach: true });
  await record(context, 'footer-bottom', () => {
    PORTRAIT_GEOMETRY_CHECKS['footer-bottom'](geometry);
    assertPhysicalFooterReach(reach);
  }, { ...replica, physicalReach: true });
}

// Stage 6: a mention opens the Android user-card dialog, not a Room (507–587).

export async function runMentionUserCard(context: MessageLinksStageContext): Promise<void> {
  const { client, base, links, ledger } = context;
  const roomName = messageLinksNames.mentionRoom(ledger.run);
  const bobName = messageLinksNames.bobName(ledger.run);
  protect(context, { bobName, rooms: { mention: { name: roomName } } });
  const owner = await base.account('ml-mention-user');
  protect(context, { local: owner });
  const bob = await base.account('ml-mention-bob');
  protect(context, { bob });
  await base.setDisplayName(bob, bobName);
  const profile = await links.displayName(owner, bob.userId);
  assertDisplayName(profile, bobName);
  await receipt(context, 'bob-profile', { exactDisplayName: true });
  const room = await base.createRoom(owner, { name: roomName });
  protect(context, { rooms: { mention: { id: room.id } } });
  assert.equal(await readRoomName(context, owner, room.id), roomName,
    'Mention Room name read back exactly');
  const login = await links.apiLogin(owner);
  assertApiLogin(login, owner.userId);
  await receipt(context, 'api-login', { userMatches: true });
  const href = messageLinksHrefs.mentionUser(bob.userId);
  protect(context, { hrefs: [href] });
  await sendFormattedReceipt(context, owner, room.id, mentionMessage(bobName, bob.userId),
    messageLinksNames.mentionTxn(ledger.run));
  sealSecrets(context);

  await startNative(context);
  await client.login(owner);
  await client.hideKeyboard();
  const mentionRoom = roomIdentity(room, owner);
  await openRoom(context, mentionRoom, 'room-open');

  // D4 pre-tap: Android's coarse-pointer model, the document marker and the one link.
  const pointer = await readAppliedProfile(client);
  assertCoarseAndroidPointer(pointer);
  const marker = await readNavigationMarker(client);
  const placeholder = await readComposerPlaceholder(client);
  assertExactPlaceholder(placeholder, roomName);
  const anchors = await readLinkAnchors(client, bobName, {
    accepts: passes((value) => assertSingleLinkAnchor(value, bobName, {
      kind: 'user', target: bob.userId, via: [], href,
    })),
    description: 'one exact mention link',
    timeoutMs: OBSERVE_MS,
  });
  const anchor = assertSingleLinkAnchor(anchors, bobName, {
    kind: 'user', target: bob.userId, via: [], href,
  });
  await receipt(context, 'mention-pre-tap', {
    coarsePointer: pointer.coarsePointer,
    platform: pointer.platform,
    maxTouchPoints: pointer.maxTouchPoints,
    // The route carries the Room id and account; keep only its digest.
    marker: {
      hrefDigest: digest(marker.href),
      timeOrigin: marker.timeOrigin,
      historyLength: marker.historyLength,
    },
    exactPlaceholder: true,
    exactHref: anchor.href === href,
    cssRect: anchor.rect,
  });
  await client.tapCurrent('.scroll a', { exactText: bobName });

  const card = await client.visible(USER_CARD, {}, CARD_MS);
  await record(context, 'card-visible', () => assert(card.visible, 'The user card is visible'), {
    visible: card.visible,
  });
  const [cardName] = await client.waitElements(`${USER_CARD} ${USER_CARD_NAME}`,
    (names) => names.length === 1 && names[0]!.text === bobName,
    'exact user-card display name', {}, OBSERVE_MS);
  await record(context, 'card-name', () => {
    assert(cardName, 'The user card shows a name');
    assert.equal(cardName.text, bobName, 'The user card names the exact display name');
  }, { exactName: cardName?.text === bobName });
  const unanchored = await readUserCardDialogModel(client, bobName, {
    accepts: passes(assertNoAnchoredPopover),
    description: 'no anchored user-card popover',
    timeoutMs: OBSERVE_MS,
  });
  await record(context, 'no-anchored-popover',
    () => assertNoAnchoredPopover(unanchored),
    { connectedBoxCount: unanchored.connectedBoxCount });
  const model = await readUserCardDialogModel(client, bobName, {
    accepts: passes(assertDialogNamesUser),
    description: 'one visible dialog naming the mentioned user',
    timeoutMs: OBSERVE_MS,
  });
  await record(context, 'dialog-name', () => assertDialogNamesUser(model), {
    dialogCount: model.dialogCount,
    containsName: model.dialogs[0]?.containsName ?? false,
  });
  assertAndroidUserCardDialog(model, bobName);
  await receipt(context, 'user-card-dialog-model', {
    role: model.dialogs[0]?.role,
    ariaLabel: model.dialogs[0]?.ariaLabel,
    ariaModal: model.dialogs[0]?.ariaModal,
    inGlobalWrapper: model.dialogs[0]?.inGlobalWrapper,
    containsCard: model.dialogs[0]?.containsCard,
    visibleDarkBackdropCount: model.visibleDarkBackdropCount,
    transparentBackdropCount: model.transparentBackdropCount,
    coarsePointer: model.coarsePointer,
    platform: model.platform,
  });
  const retained = await readComposerPlaceholder(client, {
    accepts: passes((value) => assertExactPlaceholder(value, roomName)),
    description: 'source Room placeholder retained under the user card',
    timeoutMs: OBSERVE_MS,
  });
  await record(context, 'room-retained', () => assertExactPlaceholder(retained, roomName), {
    exactPlaceholder: true,
  });
  const unchanged = await readNavigationMarker(client);
  assertNoNavigation(marker, unchanged);
  assertRoomRoute(unchanged.href, room.id, owner.userId);
  await receipt(context, 'no-navigation', {
    sameHref: true,
    sameTimeOrigin: unchanged.timeOrigin === marker.timeOrigin,
    historyLength: unchanged.historyLength,
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageLinksStageId,
  (context: MessageLinksStageContext) => Promise<void>
>> = {
  'joined-preview': runJoinedPreview,
  'federated-join': runFederatedJoin,
  'remote-unavailable': runRemoteUnavailable,
  'rejected-join': runRejectedJoin,
  'portrait-sheet': runPortraitSheet,
  'mention-user-card': runMentionUserCard,
};

interface StageReport {
  readonly id: MessageLinksStageId;
  readonly source: string;
  readonly title: string;
  readonly profile: MessageLinksProfileName;
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: string;
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: number;
  assertionRecords: number;
  assertions: MessageLinksAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 6;
  readonly expectedUniqueAssertions: 63;
  readonly expectedAssertionRecords: 63;
  readonly attempt: 1;
  readonly retries: 0;
  readonly applications: readonly string[];
  readonly stages: StageReport[];
  /** Cleanup failures that happened before any stage started. */
  cleanupErrors?: string[];
}

/** Stage diagnostics for journeys.json, which is scrubbed before publication. */
function describeFailure(error: unknown): string {
  // Keep the first frames: a bare `TimeoutError` does not say which operation expired.
  const frames = error instanceof Error && error.stack
    ? error.stack.split('\n').slice(1, 7).map((line) => line.trim()).join('\n')
    : '';
  const heading = error instanceof Error
    ? `${error.name}: ${error.message}` : String(error);
  const message = frames ? `${heading}\n${frames}` : heading;
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

/**
 * An id-free account of a cleanup failure for process output, which reaches ungated
 * CI logs. Only the two-server fixture's templated HTTP errors keep their message;
 * every other error keeps its name and, when it has one, its HTTP status. The full
 * text stays in the report, which the scrub redacts and the gate withholds.
 */
/**
 * The error rethrown to the test reporter after a failed stage. The reporter
 * prints thrown errors to the ungated job log, and Node appends an assertion's
 * actual/expected values to its message, so the shared public rethrow keeps
 * only names and first message lines, with every registered secret and every
 * Matrix Room and event-id shape redacted. The complete text stays in the
 * scrubbed journeys.json.
 */
export function redactStageFailure(
  stageId: string,
  failures: readonly unknown[],
  secrets: Readonly<Record<string, string>>,
): Error {
  return publicStageFailure(`Android message-links ${stageId} failed`, failures,
    (text) => redactSecretText(text, secrets));
}

export function redactCleanupFailure(label: string, error: unknown): Error {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof AggregateError) {
      for (const nested of value.errors) visit(nested);
    } else if (value instanceof MessageLinksHttpError) {
      parts.push(value.message);
    } else if (value instanceof Error) {
      const status: unknown = Reflect.get(value, 'status');
      parts.push(typeof status === 'number' ? `${value.name} HTTP ${status}` : value.name);
    } else {
      parts.push(typeof value);
    }
  };
  visit(error);
  return new Error(`Message-links cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessageLinksPublicationSafety;
  readonly report: {
    status: 'running' | 'passed' | 'failed';
    readonly stages: readonly {
      status: 'running' | 'passed' | 'failed';
      failureCount: number;
      error?: string;
    }[];
    cleanupErrors?: string[];
  };
  save(): Promise<void>;
}

/**
 * Register cleanups that block publication when they fail. The full failure goes to
 * `journeys.json`; fixture cleanups retire before the scrub, so it is redacted there.
 * Only an id-free error is rethrown to the namespace, whose diagnostics print it.
 */
export function guardMessageLinksCleanup(
  register: (label: string, action: () => Promise<void>) => void,
  state: GuardedCleanupState,
): (label: string, action: () => Promise<void>) => void {
  return (label, action) => register(label, async () => {
    try { await action(); }
    catch (error) {
      state.safety.cleanupFailed = true;
      state.report.status = 'failed';
      const failure = `Cleanup failed: ${label}\n${describeFailure(error)}`;
      const stage = state.report.stages.at(-1);
      if (stage) {
        stage.status = 'failed';
        stage.failureCount++;
        stage.error = stage.error ? `${stage.error}\n${failure}` : failure;
      } else {
        state.report.cleanupErrors = [...state.report.cleanupErrors ?? [], failure];
      }
      await state.save();
      throw redactCleanupFailure(label, error);
    }
  });
}

/** Single-attempt, serial six-stage run with post-cleanup publication safety. */
export async function runMessageLinksSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-links');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_LINKS_STAGES.length, 6, 'Message-links runs six stages');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 6,
          expectedUniqueAssertions: 63,
          expectedAssertionRecords: 63,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageLinksPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageLinksPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageLinksCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-links diagnostics', () =>
          report.status === 'passed'
            ? markMessageLinksDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageLinksArtifacts(output, secrets));
        guardedCleanup('Scrub message-links diagnostics', async () => {
          try { await scrubMessageLinksArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-links Android device', () => device.close());
          // Fixture cleanups register after the device, so they retire first. The
          // two-server cleanup registers before the base one, so base leaves first.
          const resources = new MatrixTestResources(matrixResources.namespace);
          resources.cleanup = guardedCleanup;
          const secondary = readSecondary(session);
          const links = createMessageLinksFixtures({ resources, signal, secondary });
          const base = createAccountFixtures(resources, signal);
          await installWithAndroidRuntimeProvenance({
            device,
            applicationId: APPLICATION_ID,
            apk: join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
            rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
            profile: DESKTOP_ACCOUNT_PROFILE,
            output: join(output, 'runtime-provenance.json'),
          });
          await writeFile(join(output, 'profiles.json'),
            `${JSON.stringify(messageLinksProfiles(), null, 2)}\n`);
          const identities = new Set<string>();
          for (const entry of MESSAGE_LINKS_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageLinksAssertion[] = [];
            const stage: StageReport = {
              id: entry.id,
              source: entry.source,
              title: entry.title,
              profile: MESSAGE_LINKS_STAGE_PROFILES[entry.id],
              status: 'running',
              durationMs: 0,
              artifact: `${entry.id}/**`,
              attempt: 1,
              retries: 0,
              expectedAssertionRecords: entry.expectedAssertionRecords,
              assertionRecords: 0,
              assertions: [],
              receipts: 0,
              failureCount: 0,
            };
            stages.push(stage);
            await save();
            const started = performance.now();
            const failures: unknown[] = [];
            console.info(`[message-links] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageLinksStageContext = {
              entry,
              client,
              base,
              links,
              secondary,
              secrets,
              safety,
              records,
              identities,
              receipts: 0,
              native: false,
              ledger: {
                run: `${resources.aliasLocalpart(`ml-${entry.id}`)}${MESSAGE_LINKS_RUN_SUFFIX[entry.id]}`,
                rooms: {},
                hrefs: [],
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageLinksRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runMessageLinksStageCleanup([
                () => client.close(),
                () => device.clearApplicationData(APPLICATION_ID),
              ], failures);
              if (failures.length > stageFailures) safety.cleanupFailed = true;
              stage.assertions = [...records];
              stage.assertionRecords = records.length;
              stage.receipts = context.receipts;
              stage.durationMs = performance.now() - started;
              stage.failureCount = failures.length;
              stage.status = failures.length ? 'failed' : 'passed';
              if (failures.length) stage.error = failures.map(describeFailure).join('\n');
              await save();
              console.info(`[message-links] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_LINKS_ASSERTION_RECORDS,
            'Every message-links parity identity was emitted once');
          signal.throwIfAborted();
          report.status = 'passed';
          await save();
        } catch (error) {
          report.status = 'failed';
          await save();
          throw error;
        }
      });
  } finally {
    if (effectiveSignal.aborted) await revokeOnAbort?.();
  }
}

// Vitest imports the helpers without launching an emulator.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void test('Android message-links journeys', { timeout: 2_700_000 },
    runMessageLinksSuite);
}
