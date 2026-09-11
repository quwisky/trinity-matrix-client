import assert from 'node:assert/strict';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';

export interface IdentityImageObservation {
  readonly visible: boolean;
  readonly src: string | null;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface IdentityPresenceObservation {
  readonly visible: boolean;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  readonly dataPresence: string | null;
}

export interface IdentityRowObservation {
  readonly name: string;
  readonly visible: boolean;
  readonly avatarCount: number;
  readonly avatarVisible: boolean;
  readonly imageCount: number;
  readonly images: readonly IdentityImageObservation[];
  readonly presence: IdentityPresenceObservation | null;
}

export interface IdentityRowsOptions {
  readonly containerSelector: string;
  readonly nameSelector: string;
  readonly exactName?: string;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function waitAndRecord<T>(
  client: AccountWorkspaceClient,
  label: string,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  let latest: T | undefined;
  try {
    const value = await waitForNativeShellState(
      async () => {
        latest = await read();
        return latest;
      },
      accepts,
      label,
      client.signal,
      timeoutMs,
    );
    await client.record(label, { assertion: label, observation: value });
    return value;
  } catch (error) {
    try {
      await client.record(`${label}-failure`, {
        assertion: label,
        observation: latest ?? null,
        error: failureMessage(error),
      });
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], `${label} observation and diagnostic failed`);
    }
    throw error;
  }
}

/** Read a narrowly allowlisted identity row snapshot from the current WebView DOM. */
export async function readIdentityRows(
  client: AccountWorkspaceClient,
  options: IdentityRowsOptions,
): Promise<readonly IdentityRowObservation[]> {
  const value = await evaluateNative(client.webview, `(() => {
    const options = ${JSON.stringify(options)};
    const isVisible = element => {
      if (!(element instanceof HTMLElement)) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility === 'visible' && style.display !== 'none';
    };
    return [...document.querySelectorAll(options.containerSelector)]
      .filter(row => {
        const name = row.querySelector(options.nameSelector)?.textContent?.trim();
        if (options.exactName !== undefined) return name === options.exactName;
        return true;
      })
      .map(row => {
        const name = row.querySelector(options.nameSelector)?.textContent?.trim() ?? '';
        const avatarElements = [...row.querySelectorAll('trn-avatar')];
        const images = [...row.querySelectorAll('trn-avatar img')].map(image => ({
          visible: isVisible(image),
          src: image.getAttribute('src'),
          complete: image instanceof HTMLImageElement && image.complete,
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
        }));
        const dot = row.querySelector('.presence-dot');
        return {
          name,
          visible: isVisible(row),
          avatarCount: avatarElements.length,
          avatarVisible: avatarElements.some(isVisible),
          imageCount: images.length,
          images,
          presence: dot ? {
            visible: isVisible(dot),
            role: dot.getAttribute('role'),
            ariaLabel: dot.getAttribute('aria-label'),
            dataPresence: dot.getAttribute('data-presence'),
          } : null,
        };
      });
  })()`);
  assert(Array.isArray(value), 'Identity row observation is an array');
  return value as IdentityRowObservation[];
}

export async function assertDecodedDmAvatar(
  client: AccountWorkspaceClient,
  partnerName: string,
): Promise<void> {
  await waitAndRecord(
    client,
    'avatar.dm.decoded-visible',
    () => readIdentityRows(client, { containerSelector: '.channel', nameSelector: '.channel__name', exactName: partnerName }),
    value => value.length === 1 && value[0]!.visible && value[0]!.avatarVisible && value[0]!.images.length === 1 && value[0]!.images[0]!.visible && value[0]!.images[0]!.complete && value[0]!.images[0]!.naturalWidth > 0 && value[0]!.images[0]!.naturalHeight > 0,
    30_000,
  );
  await waitAndRecord(
    client,
    'avatar.dm.blob-src',
    () => readIdentityRows(client, { containerSelector: '.channel', nameSelector: '.channel__name', exactName: partnerName }),
    value => value.length === 1 && value[0]!.images.length === 1 && /^blob:/.test(value[0]!.images[0]!.src ?? ''),
    15_000,
  );
}

export async function assertGroupAvatarFallback(
  client: AccountWorkspaceClient,
  groupName: string,
): Promise<void> {
  await waitAndRecord(
    client,
    'avatar.group.avatar-visible',
    () => readIdentityRows(client, { containerSelector: '.channel', nameSelector: '.channel__name', exactName: groupName }),
    value => value.length === 1 && value[0]!.visible && value[0]!.avatarVisible,
    30_000,
  );
  await waitAndRecord(
    client,
    'avatar.group.no-image',
    () => readIdentityRows(client, { containerSelector: '.channel', nameSelector: '.channel__name', exactName: groupName }),
    value => value.length === 1 && value[0]!.imageCount === 0,
    30_000,
  );
}

export async function assertMemberPresence(
  client: AccountWorkspaceClient,
  readerName: string,
  memberName: string,
): Promise<void> {
  const rows = await waitAndRecord(
    client,
    'members.exact-count',
    () => readIdentityRows(client, { containerSelector: '.members .member', nameSelector: '.member__name' }),
    value => value.length === 2,
    20_000,
  );
  assert.equal(rows.filter(row => row.name === readerName).length, 1, 'members.reader-seeded');
  assert.equal(rows.filter(row => row.name === memberName).length, 1, 'members.member-seeded');
  await client.record('members.seeded-identities', {
    assertion: 'members.seeded-identities',
    observation: rows.map(row => row.name),
  });
  const first = await waitAndRecord(
    client,
    'members.first-dot-visible',
    () => readIdentityRows(client, { containerSelector: '.members .member', nameSelector: '.member__name' }),
    value => {
      const first = value.find(row => row.presence !== null);
      return value.length === 2 && first?.presence?.visible === true;
    },
    20_000,
  );
  const firstDotRow = first.find(row => row.presence !== null)!;
  assert(firstDotRow.presence?.visible, 'members.first-dot-visible');
  await waitAndRecord(
    client,
    'members.first-dot-role',
    () => readIdentityRows(client, { containerSelector: '.members .member', nameSelector: '.member__name' }),
    value => {
      const first = value.find(row => row.presence !== null);
      return value.length === 2 && first?.presence?.role === 'img';
    },
    15_000,
  );
  await waitAndRecord(
    client,
    'members.first-dot-label',
    () => readIdentityRows(client, { containerSelector: '.members .member', nameSelector: '.member__name' }),
    value => {
      const first = value.find(row => row.presence !== null);
      return value.length === 2 && /Online|Away|Offline/.test(first?.presence?.ariaLabel ?? '');
    },
    15_000,
  );
  const readerRows = await waitAndRecord(
    client,
    'members.own-online',
    () => readIdentityRows(client, { containerSelector: '.members .member', nameSelector: '.member__name', exactName: readerName }),
    value => value.length === 1 && value[0]!.visible && value[0]!.presence?.visible === true && value[0]!.presence.dataPresence === 'online',
    20_000,
  );
  assert.equal(readerRows[0]!.presence?.dataPresence, 'online', 'members.own-online');
}

export async function assertMembersInitiallyHidden(client: AccountWorkspaceClient): Promise<void> {
  await waitAndRecord(
    client,
    'members.initially-hidden',
    () => client.elements('.members'),
    value => value.length === 0 || (value.length === 1 && !value[0]!.visible),
    15_000,
  );
}

export async function assertMembersPanelVisible(client: AccountWorkspaceClient): Promise<void> {
  await waitAndRecord(
    client,
    'members.panel-visible',
    () => client.elements('.members'),
    value => value.length === 1 && value[0]!.visible,
    15_000,
  );
}

export async function assertTimelineVisible(client: AccountWorkspaceClient): Promise<void> {
  await waitAndRecord(
    client,
    'members.timeline-visible',
    () => client.elements('.scroll'),
    value => value.length === 1 && value[0]!.visible,
    15_000,
  );
}

export async function assertDmPresence(
  client: AccountWorkspaceClient,
  partnerName: string,
): Promise<void> {
  await waitAndRecord(
    client,
    'dm.presence-visible',
    () => readIdentityRows(client, { containerSelector: '.channel', nameSelector: '.channel__name', exactName: partnerName }),
    value => value.length === 1 && value[0]!.visible && value[0]!.presence?.visible === true,
    30_000,
  );
}
