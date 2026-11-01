import { type MemberSummary } from '@trinity/data-access/room-administration';
import { type PresenceDetails } from '@trinity/data-access/identity';
import { type UserSessions, type UserTrust } from '@trinity/data-access/trust';
import { TrnToastService } from '@trinity/components/overlay';
import { fireEvent, render, screen, waitFor, within } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { IdentityChangeActionsService } from '../../identity-change/identity-change-actions.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberProfileTabComponent } from './member-profile-tab.component';

const BOB: MemberSummary = {
  userId: '@bob:hs',
  roomDisplayName: 'Bob',
  roomInitial: 'B',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
};

function presence(over: Partial<PresenceDetails> = {}): PresenceDetails {
  return {
    state: 'online',
    statusMessage: '',
    lastActiveAt: null,
    currentlyActive: true,
    ...over,
  };
}

async function build(
  inputs: {
    isSelf?: boolean;
    trust?: UserTrust | null;
    presence?: PresenceDetails | null;
    globalName?: string | null;
    showIdentityActions?: boolean;
    sessions?: UserSessions | null;
  } = {},
) {
  const toastShow = vi.fn();
  const message = vi.fn();
  const verify = vi.fn();
  const copyFailed = vi.fn();
  const sessionsOpened = vi.fn();
  const sessionsRetried = vi.fn();
  const { fixture, container } = await render(MemberProfileTabComponent, {
    inputs: {
      member: BOB,
      isSelf: inputs.isSelf ?? false,
      trust: inputs.trust ?? null,
      presence: inputs.presence ?? null,
      globalName: inputs.globalName ?? null,
      showIdentityActions: inputs.showIdentityActions ?? true,
      sessions: inputs.sessions ?? null,
    },
    on: {
      messageUser: message,
      verify,
      copyFailed,
      sessionsOpened,
      sessionsRetried,
    },
    providers: [
      MockProvider(TrnToastService, { show: toastShow }),
      MockProvider(IdentityChangeActionsService, { pending: () => null }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    toastShow,
    message,
    verify,
    copyFailed,
    sessionsOpened,
    sessionsRetried,
  };
}

const PHONE = { deviceId: 'PHONE', name: 'Phone' };
const LAPTOP = { deviceId: 'LAPTOP', name: 'Laptop' };

const unchecked = (...sessions: (typeof PHONE)[]): UserSessions => ({
  kind: 'unchecked',
  sessions,
});

const sessionsRow = () => screen.getByRole('button', { name: /^Sessions/ });
const openSessions = () => fireEvent.click(sessionsRow());
const sessionItems = () =>
  within(screen.getByRole('list', { name: 'Sessions' })).getAllByRole(
    'listitem',
  );

const byTestId = (container: Element, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const FALLBACK =
  'Could not copy the user ID. It is selected above; copy it manually.';

describe('MemberProfileTabComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Message, Copy ID and Verify for an unverified person', async () => {
    const { container, message, verify } = await build({
      trust: 'unverified',
    });

    screen.getByRole('button', { name: 'Message' }).click();
    screen.getByRole('button', { name: 'Verify' }).click();

    expect(screen.getByRole('button', { name: 'Copy ID' })).toBe(
      byTestId(container, 'member-info-copy'),
    );
    expect(byTestId(container, 'member-info-message')).not.toBeNull();
    expect(byTestId(container, 'member-info-verify')).not.toBeNull();
    expect(message).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it('offers Verify when trust is unverified', async () => {
    const { container } = await build({ trust: 'unverified' });
    expect(byTestId(container, 'member-info-verify')).not.toBeNull();
    expect(byTestId(container, 'member-info-identity-change')).toBeNull();
  });

  it.each([
    ['identity-changed', ['Acknowledge']],
    ['verified-identity-changed', ['Verify again', 'Withdraw verification']],
  ] as const)(
    'answers a %s identity in place of Verify',
    async (trust, labels) => {
      const { container } = await build({ trust });
      expect(byTestId(container, 'member-info-verify')).toBeNull();
      const actions = byTestId(container, 'member-info-identity-change');
      expect(
        [...(actions?.querySelectorAll('button') ?? [])].map((b) =>
          b.textContent?.trim(),
        ),
      ).toEqual(labels);
    },
  );

  it.each(['verified', null] as const)(
    'no Verify when trust is %s',
    async (trust) => {
      const { container } = await build({ trust });
      expect(byTestId(container, 'member-info-verify')).toBeNull();
    },
  );

  it('no Verify without identity actions', async () => {
    const { container } = await build({
      trust: 'unverified',
      showIdentityActions: false,
    });
    expect(byTestId(container, 'member-info-verify')).toBeNull();
  });

  it('no Message or Verify for yourself', async () => {
    const { container } = await build({ trust: 'unverified', isSelf: true });
    expect(byTestId(container, 'member-info-message')).toBeNull();
    expect(byTestId(container, 'member-info-verify')).toBeNull();
    expect(byTestId(container, 'member-info-copy')).not.toBeNull();
  });

  it('Status reads "Online · On holiday"', async () => {
    const { container } = await build({
      presence: presence({ statusMessage: 'On holiday' }),
    });
    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      'Online · On holiday',
    );
  });

  it.each([
    ['unavailable', 'Away'],
    ['offline', 'Offline'],
  ] as const)('Status for %s reads %s', async (state, text) => {
    const { container } = await build({ presence: presence({ state }) });
    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      text,
    );
  });

  it('offline with a last active time reads "Last seen 2 hours ago"', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const { container } = await build({
      presence: presence({
        state: 'offline',
        currentlyActive: false,
        lastActiveAt: Date.now() - 2 * 60 * 60_000,
      }),
    });
    // The shared helper uses the short Intl style.
    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      'Last seen 2 hr. ago',
    );
  });

  it('keeps "Last seen" current as time passes', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const { container, fixture } = await build({
      presence: presence({
        state: 'offline',
        currentlyActive: false,
        lastActiveAt: Date.now() - 5 * 60_000,
      }),
    });

    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();

    expect(byTestId(container, 'member-info-status')?.textContent?.trim()).toBe(
      'Last seen 6 min. ago',
    );
  });

  it('Status hidden while presence is unknown', async () => {
    await build({ presence: null });
    expect(screen.queryByText('Status')).toBeNull();
  });

  it('Global name row only when it differs', async () => {
    const { container, fixture } = await build({ globalName: null });
    expect(byTestId(container, 'member-info-global-name')).toBeNull();

    fixture.componentRef.setInput('globalName', 'Robert');
    await fixture.whenStable();
    expect(
      byTestId(container, 'member-info-global-name')?.textContent?.trim(),
    ).toBe('Robert');
  });

  describe('Sessions row', () => {
    const CHECKED: UserSessions = {
      kind: 'checked',
      notVerified: 1,
      sessions: [
        { ...PHONE, verified: false },
        { ...LAPTOP, verified: true },
      ],
    };
    const PROMPT = 'Verify Bob to check their sessions';

    it('is hidden when there is nothing to show', async () => {
      const { container } = await build({ sessions: null });
      expect(screen.queryByRole('button', { name: /^Sessions/ })).toBeNull();
      expect(container.querySelector('dl')).toBeNull();
    });

    it.each<[string, UserSessions, string]>([
      ['nothing is known yet', { kind: 'unknown' }, 'Sessions'],
      ['the list is loading', { kind: 'loading' }, 'Sessions'],
      ['the read failed', { kind: 'failed' }, 'Sessions'],
      ['the server lists none', unchecked(), 'Sessions'],
      ['one session', unchecked(PHONE), 'Sessions 1 session'],
      ['two sessions', unchecked(PHONE, LAPTOP), 'Sessions 2 sessions'],
      [
        'one of two not verified',
        CHECKED,
        'Sessions 2 sessions · 1 not verified',
      ],
      [
        'all verified',
        {
          kind: 'checked',
          notVerified: 0,
          sessions: [{ ...PHONE, verified: true }],
        },
        'Sessions 1 session',
      ],
    ])('reads right when %s', async (_case, sessions, name) => {
      await build({ sessions });
      expect(sessionsRow()).toHaveAccessibleName(name);
    });

    it('is a real button that reports its state and asks for the list only when opening', async () => {
      const { sessionsOpened } = await build({ sessions: unchecked(PHONE) });
      expect(sessionsRow().tagName).toBe('BUTTON');
      expect(sessionsRow()).toHaveAttribute('aria-expanded', 'false');
      expect(sessionsOpened).not.toHaveBeenCalled();
      expect(screen.queryByRole('list', { name: 'Sessions' })).toBeNull();

      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });
      expect(sessionsRow()).toHaveAttribute('aria-expanded', 'true');
      expect(sessionsOpened).toHaveBeenCalledOnce();

      openSessions();
      await waitFor(() =>
        expect(screen.queryByRole('list', { name: 'Sessions' })).toBeNull(),
      );
      expect(sessionsRow()).toHaveAttribute('aria-expanded', 'false');
      expect(sessionsOpened).toHaveBeenCalledOnce();
    });

    it('closes when the card moves to another member', async () => {
      const { fixture, sessionsOpened } = await build({
        sessions: unchecked(PHONE),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      fixture.componentRef.setInput('member', { ...BOB, userId: '@carol:hs' });
      await fixture.whenStable();

      expect(sessionsRow()).toHaveAttribute('aria-expanded', 'false');
      expect(sessionsOpened).toHaveBeenCalledOnce();
    });

    it('a verified member: each session says Verified or Not verified, in text', async () => {
      await build({ trust: 'verified', sessions: CHECKED });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(sessionItems().map((item) => item.textContent?.trim())).toEqual([
        expect.stringMatching(/^Phone\s*⚠ Not verified$/),
        expect.stringMatching(/^Laptop\s*✓ Verified$/),
      ]);
      expect(screen.queryByText(PROMPT)).toBeNull();
    });

    it.each([
      'unverified',
      'identity-changed',
      'verified-identity-changed',
    ] as const)(
      'a %s member: no badges, and the prompt in the room name',
      async (trust) => {
        const { container } = await build({
          trust,
          sessions: unchecked(PHONE, LAPTOP),
        });
        openSessions();
        await screen.findByRole('list', { name: 'Sessions' });

        expect(sessionItems().map((item) => item.textContent?.trim())).toEqual([
          'Phone',
          'Laptop',
        ]);
        expect(
          container.querySelector('[data-testid="member-info-session-state"]'),
        ).toBeNull();
        expect(screen.getByText(PROMPT)).toBeTruthy();
      },
    );

    it('keeps the identity-change action beside the list', async () => {
      const { container } = await build({
        trust: 'identity-changed',
        sessions: unchecked(PHONE),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });
      expect(byTestId(container, 'member-info-identity-change')).not.toBeNull();
    });

    it('renders a hostile name as text', async () => {
      const name = '<img src=x onerror=alert(1)>';
      const { container } = await build({
        sessions: unchecked({ deviceId: 'X', name }),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(sessionItems()[0]?.textContent?.trim()).toBe(name);
      expect(container.querySelector('img')).toBeNull();
    });

    it('announces loading, with no list and no prompt', async () => {
      await build({ sessions: { kind: 'loading' } });
      openSessions();

      expect((await screen.findByRole('status')).textContent).toContain(
        'Loading sessions',
      );
      expect(screen.queryByRole('list', { name: 'Sessions' })).toBeNull();
      expect(screen.queryByText(PROMPT)).toBeNull();
    });

    it('says so when the server lists none', async () => {
      await build({ sessions: unchecked() });
      openSessions();
      expect(await screen.findByText('No sessions to show')).toBeTruthy();
      expect(screen.queryByText(PROMPT)).toBeNull();
    });

    it('shows an error with Try again', async () => {
      const { sessionsRetried, sessionsOpened } = await build({
        sessions: { kind: 'failed' },
      });
      openSessions();

      expect((await screen.findByRole('alert')).textContent).toContain(
        "Couldn't load sessions",
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(sessionsRetried).toHaveBeenCalledOnce();
      expect(sessionsOpened).toHaveBeenCalledOnce();
    });

    it('scrolls a long list within a fixed height, by keyboard too', async () => {
      await build({ sessions: unchecked(PHONE, LAPTOP) });
      openSessions();
      const list = await screen.findByRole('list', { name: 'Sessions' });

      expect(list.className).toContain('max-h-');
      expect(list.className).toContain('overflow-y-auto');
      expect(list).toHaveAttribute('tabindex', '0');
    });

    it('wraps untrusted names and ids rather than overflowing', async () => {
      await build({ sessions: unchecked(PHONE) });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(screen.getByText('Phone').className).toContain(
        '[overflow-wrap:anywhere]',
      );
    });
  });

  it('copies the user id and toasts once the write resolves', async () => {
    // The real writeText returns a Promise; the toast must follow it, not fire blind.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build();

    cmp.copyId();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      'User ID copied.',
      expect.anything(),
    );
  });

  it('does not claim success when the clipboard write is rejected', async () => {
    // Denied permission / non-secure context. Telling the user "copied" here leaves
    // them believing they have the id when the clipboard is untouched.
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow, copyFailed } = await build();

    cmp.copyId();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).not.toHaveBeenCalledWith(
      'User ID copied.',
      expect.anything(),
    );
    expect(copyFailed).toHaveBeenCalledOnce();
    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the same manual fallback when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const { cmp, toastShow } = await build();

    cmp.copyId();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the fallback when clipboard exists without writeText', async () => {
    vi.stubGlobal('navigator', { clipboard: {} });
    const { cmp, toastShow } = await build();

    expect(() => cmp.copyId()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the fallback when writeText throws synchronously', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: () => {
          throw new Error('not available');
        },
      },
    });
    const { cmp, toastShow } = await build();

    expect(() => cmp.copyId()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      FALLBACK,
      expect.objectContaining({ variant: 'danger' }),
    );
  });
});
