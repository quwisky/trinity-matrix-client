import { render } from '@trinity/testing';
import { TrnDialogRef } from '@trinity/components/overlay';
import { InvitesService } from '@trinity/data-access/invites';
import {
  RoomLinkService,
  type RoomLinkPreview,
} from '@trinity/data-access/rooms';
import { MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomLinkPreviewComponent } from './room-link-preview.component';

function preview(overrides: Partial<RoomLinkPreview> = {}): RoomLinkPreview {
  return {
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
    sheet?: boolean;
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
      sheet: options.sheet ?? false,
    },
    providers: [
      MockProvider(TrnDialogRef, { close }),
      { provide: RoomLinkService, useValue: { preview: load, join, knock } },
      { provide: InvitesService, useValue: { acceptInvite: accept } },
    ],
  });
  return { ...rendered, close, load, join, knock, accept };
}

describe('RoomLinkPreviewComponent', () => {
  afterEach(() => vi.restoreAllMocks());

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

    expect(accept).toHaveBeenCalledWith('!room:hs');
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
      container.querySelector('[data-testid=room-link-close]'),
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

  it('opts into the native sheet styling when requested', async () => {
    const { fixture } = await build({ sheet: true });
    expect(fixture.nativeElement.classList).toContain(
      'room-link-preview--sheet',
    );
  });
});
