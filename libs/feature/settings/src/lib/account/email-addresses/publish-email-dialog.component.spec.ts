import { Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogRef } from '@trinity/components/overlay';
import {
  IdentityServerService,
  type PendingPublish,
  type PublishLinkResult,
  type PublishResult,
} from '@trinity/data-access/contact-addresses';
import { fireEvent, render, screen } from '@trinity/testing';
import { PublishEmailDialogComponent } from './publish-email-dialog.component';

const ALICE = '@alice:example.org';
const URL = 'https://vector.im';
const PENDING: PendingPublish = {
  accountId: ALICE,
  url: URL,
  email: 'a@b.c',
  sid: 's',
  clientSecret: 'c',
  sendAttempt: 1,
};

async function setup(first?: Observable<PublishLinkResult>) {
  const identity = {
    sendPublishLink: vi.fn(
      (): Observable<PublishLinkResult> =>
        first ?? of({ kind: 'sent', pending: PENDING }),
    ),
    resendPublishLink: vi.fn((): Observable<PublishLinkResult> =>
      of({ kind: 'sent', pending: { ...PENDING, sendAttempt: 2 } }),
    ),
    publish: vi.fn((): Observable<PublishResult> => of({ kind: 'published' })),
  };
  const close = vi.fn();
  const rendered = await render(PublishEmailDialogComponent, {
    inputs: { accountId: ALICE, url: URL, email: 'a@b.c' },
    providers: [
      { provide: IdentityServerService, useValue: identity },
      { provide: TrnDialogRef, useValue: { close, titleId: 't' } },
    ],
  });
  await rendered.fixture.whenStable();
  rendered.fixture.detectChanges();
  return { ...rendered, identity, close };
}

describe('PublishEmailDialogComponent', () => {
  it('sends the link when it opens and shows the host-named body', async () => {
    const { identity, container } = await setup();

    expect(identity.sendPublishLink).toHaveBeenCalledWith(ALICE, URL, 'a@b.c');
    expect(
      screen.getByRole('heading', { name: 'Check your email' }),
    ).toBeTruthy();
    expect(screen.getByTestId('publish-email-sent').textContent).toContain(
      'vector.im sent a link to a@b.c. Open it, then select Continue.',
    );
    expect(container.querySelector('#publish-email-body')).toBeTruthy();
  });

  it('shows why sending failed and offers Close', async () => {
    const { close } = await setup(
      of({ kind: 'refused', reason: 'unreachable' } as const),
    );

    expect(screen.getByTestId('publish-email-stopped').textContent).toContain(
      'Trinity couldn’t reach vector.im. Try again later.',
    );
    fireEvent.click(screen.getByTestId('publish-email-close'));
    expect(close).toHaveBeenCalled();
  });

  it('Continue publishes and closes with published', async () => {
    const { identity, close } = await setup();

    fireEvent.click(screen.getByTestId('publish-email-continue'));

    expect(identity.publish).toHaveBeenCalledWith(PENDING);
    expect(close).toHaveBeenCalledWith({ kind: 'published' });
  });

  it('stays on the step with the not-opened line when not verified', async () => {
    const { identity, fixture, close } = await setup();
    identity.publish.mockReturnValueOnce(
      of({ kind: 'not-verified', pending: PENDING }),
    );

    fireEvent.click(screen.getByTestId('publish-email-continue'));
    fixture.detectChanges();

    expect(
      screen.getByTestId('publish-email-not-verified').textContent,
    ).toContain('That link hasn’t been opened yet.');
    expect(close).not.toHaveBeenCalled();
  });

  it('Resend asks for a fresh link and says so', async () => {
    const { identity, fixture } = await setup();

    fireEvent.click(screen.getByTestId('publish-email-resend'));
    fixture.detectChanges();

    expect(identity.resendPublishLink).toHaveBeenCalledWith(PENDING);
    expect(screen.getByTestId('publish-email-resent').textContent).toContain(
      'We sent a new link to a@b.c.',
    );
  });

  it('ignores Continue while a publish is in flight', async () => {
    const { identity, fixture } = await setup();
    identity.publish.mockReturnValueOnce(new Subject<PublishResult>());

    fireEvent.click(screen.getByTestId('publish-email-continue'));
    fixture.detectChanges();
    fireEvent.click(screen.getByTestId('publish-email-continue'));

    expect(identity.publish).toHaveBeenCalledTimes(1);
  });

  it('keeps Continue possible after a brief failure', async () => {
    const { identity, fixture } = await setup();
    identity.publish.mockReturnValueOnce(
      of({ kind: 'refused', reason: 'unreachable' } as const),
    );

    fireEvent.click(screen.getByTestId('publish-email-continue'));
    fixture.detectChanges();

    expect(
      screen.getByTestId('publish-email-resend-error').textContent,
    ).toContain('Trinity couldn’t reach vector.im. Try again later.');
    expect(
      (screen.getByTestId('publish-email-continue') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
