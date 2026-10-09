import { type RoomLinkPreview } from '@trinity/data-access/discovery';
import { render, screen, within } from '@trinity/testing';
import { TrnDialogRef } from '@trinity/components/overlay';
import { AVATAR_RESOLVER } from '@trinity/components/generic-content';
import { InvitesService } from '@trinity/data-access/room-library';
import { RoomLinkService } from '@trinity/data-access/discovery';
import { MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomLinkPreviewComponent } from './room-link-preview.component';

function preview(overrides: Partial<RoomLinkPreview> = {}): RoomLinkPreview {
  return {
    accountId: '@me:hs',
    roomId: '!room:hs',
    requestedAddress: '#linked:hs',
    canonicalAddress: '#canonical:hs',
    name: 'Linked room',
    initial: 'L',
    topic: 'A useful room',
    avatarMxc: null,
    memberCount: 12,
    encrypted: true,
    joinRule: 'public',
    membership: 'leave',
    action: 'join',
    isSpace: false,
    via: ['hs'],
    ...overrides,
  };
}

async function build(
  options: {
    value?: RoomLinkPreview;
    previewRequest?: Observable<RoomLinkPreview>;
    join?: ReturnType<typeof vi.fn>;
    knock?: ReturnType<typeof vi.fn>;
    accept?: ReturnType<typeof vi.fn>;
    accountId?: string;
    resolveAvatar?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const close = vi.fn();
  const previewRequest =
    options.previewRequest ?? of(options.value ?? preview());
  const load = vi.fn(() => previewRequest);
  const join = options.join ?? vi.fn(() => of('!room:hs'));
  const knock = options.knock ?? vi.fn(() => of(undefined));
  const accept = options.accept ?? vi.fn(() => of(undefined));
  const rendered = await render(RoomLinkPreviewComponent, {
    inputs: {
      target: {
        kind: 'room',
        roomIdOrAlias: '!room:hs',
        via: ['hs'],
      },
      ...(options.accountId ? { accountId: options.accountId } : {}),
    },
    providers: [
      MockProvider(TrnDialogRef, { close }),
      { provide: RoomLinkService, useValue: { preview: load, join, knock } },
      { provide: InvitesService, useValue: { acceptInvite: accept } },
      ...(options.resolveAvatar
        ? [{ provide: AVATAR_RESOLVER, useValue: options.resolveAvatar }]
        : []),
    ],
  });
  return { ...rendered, close, load, join, knock, accept };
}

describe('RoomLinkPreviewComponent', () => {
  it('shows its title in the shared dialog shell', async () => {
    await build();

    expect(
      within(screen.getByTestId('dialog-surface')).getByRole('heading', {
        level: 2,
        name: 'Room information',
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('dialog-footer')).getByTestId(
        'room-link-primary',
      ),
    ).toBeTruthy();
  });

  afterEach(() => vi.restoreAllMocks());

  it('loads as the invited account when one is named', async () => {
    const { load } = await build({ accountId: '@work:hs' });

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ roomIdOrAlias: '!room:hs' }),
      '@work:hs',
    );
  });

  it("fetches the preview's avatar through the previewed account", async () => {
    const resolveAvatar = vi.fn(() => of('blob:avatar'));
    await build({
      value: preview({ accountId: '@work:hs', avatarMxc: 'mxc://hs/avatar' }),
      resolveAvatar,
    });

    expect(resolveAvatar).toHaveBeenCalledWith(
      'mxc://hs/avatar',
      expect.any(Number),
      '@work:hs',
    );
  });

  it('loads as the active account for a pasted link', async () => {
    const { load } = await build();

    expect(load).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('announces loading before a deferred preview resolves', async () => {
    const request = new Subject<RoomLinkPreview>();
    const { container } = await build({ previewRequest: request });

    expect(container.querySelector('[role=status]')?.textContent).toContain(
      'Loading room information',
    );
  });

  it('shows available room facts and renders a hostile topic as text', async () => {
    const { container } = await build({
      value: preview({ topic: '<img src=x onerror=alert(1)>Safe text' }),
    });

    expect(container.textContent).toContain('Linked room');
    expect(container.textContent).toContain('#canonical:hs');
    expect(container.textContent).toContain('12');
    expect(container.textContent).toContain('Encrypted');
    expect(container.textContent).toContain('Anyone can join');
    const topic = container.querySelector('[data-testid=room-link-topic]');
    expect(topic?.textContent).toContain(
      '<img src=x onerror=alert(1)>Safe text',
    );
    expect(topic?.querySelector('img')).toBeNull();
  });

  it('does not join until pressed, then exposes success and Open before routing', async () => {
    const join = vi.fn(() => of('!joined:hs'));
    const { container, close, fixture } = await build({ join });
    const primary = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid=room-link-primary]',
      )!;

    expect(join).not.toHaveBeenCalled();
    expect(primary().textContent).toContain('Join room');
    primary().click();
    await fixture.whenStable();

    expect(join).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Room joined');
    expect(primary().textContent).toContain('Open room');

    primary().click();
    expect(close).toHaveBeenCalledWith({
      accountId: '@me:hs',
      roomId: '!joined:hs',
      isSpace: false,
      membershipChanged: true,
    });
  });

  it('accepts an existing invitation through InvitesService', async () => {
    const accept = vi.fn(() => of(undefined));
    const { container, join, fixture } = await build({
      value: preview({ membership: 'invite', action: 'accept' }),
      accept,
    });

    container
      .querySelector<HTMLButtonElement>('[data-testid=room-link-primary]')!
      .click();
    await fixture.whenStable();

    expect(accept).toHaveBeenCalledWith('!room:hs', '@me:hs');
    expect(join).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Invitation accepted');
  });

  it('shows knock success without offering Open', async () => {
    const { container, knock, close, fixture } = await build({
      value: preview({ joinRule: 'knock', action: 'knock' }),
    });

    container
      .querySelector<HTMLButtonElement>('[data-testid=room-link-primary]')!
      .click();
    await fixture.whenStable();

    expect(knock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Request sent');
    expect(
      container.querySelector('[data-testid=room-link-primary]'),
    ).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps a failed Join open and retryable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const join = vi
      .fn()
      .mockReturnValueOnce(
        throwError(() => new MatrixError({ errcode: 'M_UNKNOWN' }, 503)),
      )
      .mockReturnValueOnce(of('!joined:hs'));
    const { container, close, fixture } = await build({ join });
    const primary = container.querySelector<HTMLButtonElement>(
      '[data-testid=room-link-primary]',
    )!;

    primary.focus();
    primary.click();
    await fixture.whenStable();
    expect(container.textContent).toContain('homeserver is unavailable');
    expect(primary.disabled).toBe(false);
    expect(primary.getAttribute('aria-disabled')).toBe('false');
    expect(document.activeElement).toBe(primary);
    expect(close).not.toHaveBeenCalled();

    primary.click();
    await fixture.whenStable();
    expect(join).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Room joined');
  });

  it('shows a typed preview error and retries when allowed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const request = new Subject<RoomLinkPreview>();
    const { container, load, fixture } = await build({
      previewRequest: request,
    });
    request.error(new MatrixError({ errcode: 'M_UNKNOWN' }, 503));
    await fixture.whenStable();

    expect(container.textContent).toContain('Homeserver unavailable');
    const error = container.querySelector<HTMLElement>(
      '[data-testid=room-link-load-error]',
    )!;
    expect(error.getAttribute('role')).toBe('alert');
    const retry = error.querySelector<HTMLButtonElement>('button')!;
    retry.focus();
    retry.click();
    expect(load).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid=dialog-close]'),
    );
  });

  it('explains a restricted room without offering an impossible action', async () => {
    const { container } = await build({
      value: preview({ joinRule: 'restricted', action: 'none' }),
    });

    expect(container.textContent).toContain('Membership is restricted');
    expect(
      container.querySelector('[data-testid=room-link-primary]'),
    ).toBeNull();
  });

  it('explains when an allowed-room membership permits a restricted join', async () => {
    const { container } = await build({
      value: preview({ joinRule: 'knock_restricted', action: 'join' }),
    });

    expect(container.textContent).toContain('Restricted — you can join');
    expect(
      container.querySelector('[data-testid=room-link-primary]')?.textContent,
    ).toContain('Join room');
  });
});
