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
  const sessionsClosed = vi.fn();
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
      sessionsClosed,
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
    sessionsClosed,
    sessionsRetried,
  };
}

const PHONE = { deviceId: 'PHONE', shownId: 'PHONE', name: 'Phone' };
const LAPTOP = { deviceId: 'LAPTOP', shownId: 'LAPTOP', name: 'Laptop' };

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
    const prompt = () =>
      screen
        .queryByTestId('member-info-sessions-prompt')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? null;

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
        expect.stringMatching(/^Phone\s*PHONE\s*⚠ Not verified$/),
        expect.stringMatching(/^Laptop\s*LAPTOP\s*✓ Verified$/),
      ]);
      expect(prompt()).toBeNull();
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
          expect.stringMatching(/^Phone\s*PHONE$/),
          expect.stringMatching(/^Laptop\s*LAPTOP$/),
        ]);
        expect(
          container.querySelector('[data-testid="member-info-session-state"]'),
        ).toBeNull();
        expect(prompt()).toBe(PROMPT);
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
        sessions: unchecked({ deviceId: 'X', shownId: 'X', name }),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(screen.getByTestId('member-info-session-name').textContent).toBe(
        name,
      );
      expect(container.querySelector('img')).toBeNull();
    });

    it('announces loading, with no list and no prompt', async () => {
      await build({ sessions: { kind: 'loading' } });
      openSessions();

      await waitFor(() =>
        expect(
          screen.getByTestId('member-info-sessions-status').textContent,
        ).toContain('Loading sessions'),
      );
      expect(screen.queryByRole('list', { name: 'Sessions' })).toBeNull();
      expect(prompt()).toBeNull();
    });

    it('says so when the server lists none', async () => {
      await build({ sessions: unchecked() });
      openSessions();
      expect(await screen.findByText('No sessions to show')).toBeTruthy();
      expect(prompt()).toBeNull();
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

    it('takes a keyboard stop only when the list overflows', async () => {
      const heights = (scroll: number) => {
        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(
          scroll,
        );
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(192);
      };
      heights(192);
      const { fixture } = await build({ sessions: unchecked(PHONE) });
      openSessions();
      const list = await screen.findByRole('list', { name: 'Sessions' });
      await fixture.whenStable();
      expect(list).not.toHaveAttribute('tabindex');

      heights(400);
      fixture.componentRef.setInput('sessions', unchecked(PHONE, LAPTOP));
      await waitFor(() => expect(list).toHaveAttribute('tabindex', '0'));
      vi.restoreAllMocks();
    });

    it('keeps list semantics for Safari, and controls its panel', async () => {
      await build({ sessions: unchecked(PHONE) });
      const panelId = sessionsRow().getAttribute('aria-controls') as string;
      const panel = document.getElementById(panelId) as HTMLElement;
      expect(panel.tagName).toBe('DD');
      expect(panel).not.toHaveAttribute('hidden');
      expect(panel.querySelector('ul')).toBeNull();

      openSessions();
      const list = await screen.findByRole('list', { name: 'Sessions' });
      expect(list).toHaveAttribute('role', 'list');
      expect(panel.contains(list)).toBe(true);
    });

    it('shows the id beneath a name, so a name cannot pose as anything', async () => {
      await build({ sessions: unchecked(PHONE) });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(screen.getByTestId('member-info-session-name').textContent).toBe(
        'Phone',
      );
      expect(screen.getByTestId('member-info-session-id').textContent).toBe(
        'PHONE',
      );
    });

    it('a name posing as a state reads as a name, with its id, and no badge', async () => {
      await build({
        trust: 'unverified',
        sessions: unchecked({
          deviceId: 'ID',
          shownId: 'ID',
          name: '✓ Verified',
        }),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(screen.queryByTestId('member-info-session-state')).toBeNull();
      expect(screen.getByTestId('member-info-session-name').textContent).toBe(
        '✓ Verified',
      );
      expect(screen.getByTestId('member-info-session-id').textContent).toBe(
        'ID',
      );
    });

    it('a name that is the id takes one line', async () => {
      await build({
        sessions: unchecked({ deviceId: 'ID', shownId: 'ID', name: 'ID' }),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(screen.getByTestId('member-info-session-name').textContent).toBe(
        'ID',
      );
      expect(screen.queryByTestId('member-info-session-id')).toBeNull();
    });

    it('a name that fell back to an escaped id takes one line, not blank', async () => {
      await build({
        sessions: unchecked({
          deviceId: '\u200B',
          shownId: '\\u{200B}',
          name: '\\u{200B}',
        }),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(screen.getByTestId('member-info-session-name').textContent).toBe(
        '\\u{200B}',
      );
      expect(screen.queryByTestId('member-info-session-id')).toBeNull();
    });

    it('renders a clone beside the session it copies, each with its own id', async () => {
      await build({
        sessions: unchecked(
          { deviceId: 'ABC', shownId: 'ABC', name: 'ABC' },
          { deviceId: 'ABC\u200B', shownId: 'ABC\\u{200B}', name: 'ABC' },
        ),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(sessionItems()).toHaveLength(2);
      expect(
        screen
          .getAllByTestId('member-info-session-id')
          .map((id) => id.textContent),
      ).toEqual(['ABC\\u{200B}']);
    });

    it('isolates untrusted text from what sits around it', async () => {
      await build({ sessions: unchecked(PHONE) });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });

      expect(screen.getByTestId('member-info-session-name').tagName).toBe(
        'BDI',
      );
      expect(screen.getByTestId('member-info-session-id').tagName).toBe('BDI');
      expect(
        screen.getByTestId('member-info-sessions-prompt').querySelector('bdi')
          ?.textContent,
      ).toBe('Bob');
    });

    it('announces loading through a region that was already there', async () => {
      const { fixture } = await build({ sessions: unchecked(PHONE) });
      const region = screen.getByTestId('member-info-sessions-status');
      expect(region).toHaveAttribute('role', 'status');
      expect(region.textContent).toBe('');

      fixture.componentRef.setInput('sessions', { kind: 'loading' });
      openSessions();

      await waitFor(() =>
        expect(region.textContent).toContain('Loading sessions'),
      );
      expect(screen.getByTestId('member-info-sessions-status')).toBe(region);
    });

    it.each(['loading', 'unknown'] as const)(
      'a closed row says nothing while %s',
      async (kind) => {
        await build({ sessions: { kind } });
        expect(
          screen.getByTestId('member-info-sessions-status').textContent,
        ).toBe('');
      },
    );

    it('follows trust with the list open', async () => {
      const { fixture } = await build({
        trust: 'unverified',
        sessions: unchecked(PHONE),
      });
      openSessions();
      await screen.findByRole('list', { name: 'Sessions' });
      expect(prompt()).toBe(PROMPT);

      fixture.componentRef.setInput('sessions', {
        kind: 'checked',
        notVerified: 1,
        sessions: [{ ...PHONE, verified: false }],
      });
      await fixture.whenStable();

      expect(prompt()).toBeNull();
      expect(
        screen.getByTestId('member-info-session-state').textContent,
      ).toContain('Not verified');

      fixture.componentRef.setInput('sessions', unchecked(PHONE));
      await fixture.whenStable();

      expect(screen.queryByTestId('member-info-session-state')).toBeNull();
      expect(prompt()).toBe(PROMPT);
    });

    describe('focus around Try again', () => {
      const failed = async () => {
        const built = await build({ sessions: { kind: 'failed' } });
        openSessions();
        const retry = await screen.findByRole('button', { name: 'Try again' });
        retry.focus();
        return { ...built, retry };
      };
      const set = async (
        fixture: Awaited<ReturnType<typeof build>>['fixture'],
        sessions: UserSessions,
      ) => {
        fixture.componentRef.setInput('sessions', sessions);
        await fixture.whenStable();
      };

      it('moves to the row while loading, so it does not fall to the body', async () => {
        const { fixture, retry } = await failed();

        fireEvent.click(retry);
        await set(fixture, { kind: 'loading' });

        expect(document.activeElement).toBe(sessionsRow());
      });

      it('returns to Try again when the retry fails too', async () => {
        const { fixture, retry } = await failed();

        fireEvent.click(retry);
        await set(fixture, { kind: 'loading' });
        await set(fixture, { kind: 'failed' });

        await waitFor(() =>
          expect(document.activeElement).toBe(
            screen.getByRole('button', { name: 'Try again' }),
          ),
        );
      });

      it('stays on the row when the retry works, even if a later read fails', async () => {
        const { fixture, retry } = await failed();

        fireEvent.click(retry);
        await set(fixture, { kind: 'loading' });
        await set(fixture, unchecked(PHONE));
        expect(document.activeElement).toBe(sessionsRow());

        sessionsRow().blur();
        await set(fixture, { kind: 'failed' });

        expect(document.activeElement).toBe(document.body);
      });
    });

    describe('the row and the state behind it', () => {
      it('says when it closes, so a closed row stops using the network', async () => {
        const { sessionsClosed } = await build({ sessions: unchecked(PHONE) });
        openSessions();
        await screen.findByRole('list', { name: 'Sessions' });
        expect(sessionsClosed).not.toHaveBeenCalled();

        openSessions();

        expect(sessionsClosed).toHaveBeenCalledOnce();
      });

      it('asks again when an open row comes back with its state rebuilt', async () => {
        const { fixture, sessionsOpened } = await build({
          sessions: unchecked(PHONE),
        });
        openSessions();
        await screen.findByRole('list', { name: 'Sessions' });
        expect(sessionsOpened).toHaveBeenCalledOnce();

        fixture.componentRef.setInput('sessions', null);
        await fixture.whenStable();
        fixture.componentRef.setInput('sessions', { kind: 'unknown' });
        await fixture.whenStable();

        expect(sessionsOpened).toHaveBeenCalledTimes(2);
      });

      it('does not ask when a closed row comes back', async () => {
        const { fixture, sessionsOpened } = await build({
          sessions: { kind: 'unknown' },
        });
        fixture.componentRef.setInput('sessions', null);
        await fixture.whenStable();
        fixture.componentRef.setInput('sessions', { kind: 'unknown' });
        await fixture.whenStable();

        expect(sessionsOpened).not.toHaveBeenCalled();
      });

      it('a card reused for someone else starts closed, and asks nothing', async () => {
        const { fixture, sessionsOpened } = await build({
          sessions: unchecked(PHONE),
        });
        openSessions();
        await screen.findByRole('list', { name: 'Sessions' });
        expect(sessionsOpened).toHaveBeenCalledOnce();

        fixture.componentRef.setInput('member', {
          ...BOB,
          userId: '@carol:hs',
        });
        fixture.componentRef.setInput('sessions', { kind: 'unknown' });
        await fixture.whenStable();

        expect(sessionsRow()).toHaveAttribute('aria-expanded', 'false');
        expect(sessionsOpened).toHaveBeenCalledOnce();
      });
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
