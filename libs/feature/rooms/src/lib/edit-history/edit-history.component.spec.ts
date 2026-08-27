import { fireEvent, render, waitFor } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, map, of, throwError, timer } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  TrnDialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  EditHistoryService,
  type EditHistoryResult,
} from '@trinity/data-access/timeline';
import { MediaService } from '@trinity/data-access/media';
import { type MessageRevisionView } from '@trinity/util/matrix';
import { EditHistoryComponent } from './edit-history.component';

function revision(
  over: Partial<MessageRevisionView> = {},
): MessageRevisionView {
  return {
    id: '$1',
    timestamp: 1700000000000,
    body: 'hello',
    html: null,
    kind: 'text',
    isOwn: false,
    ...over,
  };
}

async function build(
  source: Observable<EditHistoryResult> = of({
    revisions: [revision()],
    truncated: false,
  }),
) {
  const close = vi.fn();
  const revisions = vi.fn(() => source);
  const remove = vi.fn(() => of(undefined));
  const confirm = vi.fn().mockResolvedValue(true);
  const toast = vi.fn();
  const media = {
    resolveMedia: vi.fn(() => of('blob:wave')),
    pin: vi.fn(),
    unpin: vi.fn(),
  };
  const result = await render(EditHistoryComponent, {
    inputs: { roomId: '!r:hs', eventId: '$orig' },
    providers: [
      MockProvider(EditHistoryService, {
        revisions,
        removeRevision: remove,
      }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnAlertService, { confirm }),
      MockProvider(TrnToastService, { show: toast }),
      { provide: MediaService, useValue: media },
    ],
  });
  return { ...result, close, revisions, remove, confirm, toast, media };
}

/** The rendered label of every entry, in order. */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.revision__label')].map((el) =>
    (el.textContent ?? '').trim(),
  );
}

describe('EditHistoryComponent', () => {
  it('fetches the history for the message it was opened for', async () => {
    const { revisions } = await build();

    // Inputs arrive via setInput after construction, so this proves the fetch waited
    // for them instead of reading unset required inputs.
    expect(revisions).toHaveBeenCalledWith('!r:hs', '$orig');
    expect(revisions).toHaveBeenCalledOnce();
  });

  it('lists the versions oldest first, naming only the ends', async () => {
    const { container } = await build(
      of({
        revisions: [
          revision({ id: '$a', body: 'first' }),
          revision({ id: '$b', body: 'middle' }),
          revision({ id: '$c', body: 'latest' }),
        ],
        truncated: false,
      }),
    );

    expect(labels(container)).toEqual([
      'Original',
      'Edited',
      'Current version',
    ]);
    expect(container.textContent).toContain('first');
    expect(container.textContent).toContain('latest');
  });

  // One entry means nothing replaced it, so calling it the "current version" would
  // imply an edit the list doesn't show.
  it('calls a lone version the original and nothing else', async () => {
    const { container } = await build(
      of({ revisions: [revision()], truncated: false }),
    );

    expect(labels(container)).toEqual(['Original']);
  });

  it('admits when the list is incomplete', async () => {
    const { container } = await build(
      of({ revisions: [revision()], truncated: true }),
    );

    expect(
      container.querySelector('[data-testid=edit-history-truncated]'),
    ).not.toBeNull();
  });

  it('does not claim truncation when the list is complete', async () => {
    const { container } = await build();

    expect(
      container.querySelector('[data-testid=edit-history-truncated]'),
    ).toBeNull();
  });

  it('shows why the history could not be loaded', async () => {
    const { container } = await build(
      throwError(() => new Error('This message was deleted.')),
    );

    const error = container.querySelector('[data-testid=edit-history-error]');
    expect(error?.textContent).toContain('This message was deleted.');
    expect(container.querySelector('.revision')).toBeNull();
  });

  it('renders a formatted version as markup and a plain one as text', async () => {
    const { container, fixture } = await build(
      of({
        revisions: [
          revision({ id: '$a', body: 'plain' }),
          revision({ id: '$b', body: 'rich', html: '<strong>rich</strong>' }),
        ],
        truncated: false,
      }),
    );
    // As-sent rendering: with highlighting on, the row would also carry what changed.
    fixture.componentInstance.showDiff.set(false);
    fixture.detectChanges();

    expect(container.querySelector('.revision__text strong')?.textContent).toBe(
      'rich',
    );
    expect(container.textContent).toContain('plain');
  });

  it('resolves custom emoji inside an earlier formatted version', async () => {
    const html =
      '<img class="mx-emoticon" data-mx-emoticon src="mxc://hs/wave" alt=":wave:">';
    const { container, media } = await build(
      of({
        revisions: [revision({ body: ':wave:', html })],
        truncated: false,
      }),
    );

    await waitFor(() =>
      expect(media.resolveMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mxc: 'mxc://hs/wave' }),
        'thumbnail',
      ),
    );
    expect(
      (container.querySelector('img.mx-emoticon') as HTMLImageElement).src,
    ).toBe('blob:wave');
  });

  // The dialog exists to answer "what changed", so it answers it without being asked.
  it('highlights what each edit changed, by default', async () => {
    const { container } = await build(
      of({
        revisions: [
          revision({ id: '$a', body: 'meet at noon' }),
          revision({ id: '$b', body: 'meet at midnight' }),
        ],
        truncated: false,
      }),
    );

    const rows = container.querySelectorAll('.revision');
    // The original has nothing to compare against.
    expect(rows[0].querySelector('.diff-ins')).toBeNull();
    expect(rows[1].querySelector('ins.diff-ins')?.textContent).toBe('midnight');
    expect(rows[1].querySelector('del.diff-del')?.textContent).toBe('noon');
  });

  // Each row answers "what did THIS edit change", so it compares against the version
  // before it. Comparing everything against the original would make the last row read as
  // the sum of every edit ever made.
  it('compares each version with the one before it, not with the original', async () => {
    const { container } = await build(
      of({
        revisions: [
          revision({ id: '$a', body: 'aaa' }),
          revision({ id: '$b', body: 'bbb' }),
          revision({ id: '$c', body: 'ccc' }),
        ],
        truncated: false,
      }),
    );

    const rows = container.querySelectorAll('.revision');
    expect(rows[1].querySelector('del.diff-del')?.textContent).toBe('aaa');
    // The last row struck out "bbb" — what it actually replaced — not "aaa".
    expect(rows[2].querySelector('del.diff-del')?.textContent).toBe('bbb');
    expect(rows[2].textContent).not.toContain('aaa');
  });

  // The directives delegate from the body container, and the diff rewrites that
  // container's contents — so this is where a permalink would quietly stop working.
  it('still routes a permalink inside a highlighted version', async () => {
    const { container, close } = await build(
      of({
        revisions: [
          revision({ id: '$a', body: 'ask bob', html: 'ask bob' }),
          revision({
            id: '$b',
            body: 'ask Bob please',
            html: 'ask <a href="https://matrix.to/#/@bob:hs">Bob</a> please',
          }),
        ],
        truncated: false,
      }),
    );

    // The row is diffed (highlighting is on by default) and the link still works.
    expect(container.querySelector('.revision ins.diff-ins')).not.toBeNull();
    fireEvent.click(container.querySelectorAll('.revision__text a')[0]);

    expect(close).toHaveBeenCalledWith({ kind: 'user', userId: '@bob:hs' });
  });

  it('switches between the changes and the message as sent', async () => {
    const { container, fixture } = await build(
      of({
        revisions: [
          revision({ id: '$a', body: 'meet at noon' }),
          revision({ id: '$b', body: 'meet at midnight' }),
        ],
        truncated: false,
      }),
    );
    const toggle = container.querySelector(
      '[data-testid=edit-history-toggle]',
    ) as HTMLElement;

    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(toggle);
    fixture.detectChanges(); // zoneless: the signal changed, render the result

    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('.diff-ins')).toBeNull();
    // The struck-out old wording is gone with it — this is the message as sent.
    expect(container.textContent).not.toContain('noon at midnight');

    fireEvent.click(toggle);
    fixture.detectChanges();

    expect(container.querySelector('ins.diff-ins')).not.toBeNull();
  });

  it('offers no toggle when there is only one version to look at', async () => {
    const { container } = await build(
      of({ revisions: [revision()], truncated: false }),
    );

    expect(
      container.querySelector('[data-testid=edit-history-toggle]'),
    ).toBeNull();
  });

  it('leaves a version it could not decrypt undiffed', async () => {
    const { container } = await build(
      of({
        revisions: [
          revision({ id: '$a', body: 'hello' }),
          revision({ id: '$b', kind: 'undecryptable', body: 'no key' }),
        ],
        truncated: false,
      }),
    );

    expect(container.querySelector('.diff-ins')).toBeNull();
    expect(container.textContent).toContain('no key');
  });

  it('says so when a version cannot be decrypted, without rendering markup', async () => {
    const { container } = await build(
      of({
        revisions: [
          revision({ kind: 'undecryptable', body: '⚠️ Unable to decrypt' }),
        ],
        truncated: false,
      }),
    );

    expect(container.textContent).toContain('Unable to decrypt');
    expect(container.querySelector('.msg__text--html')).toBeNull();
  });

  // Following a permalink under the dialog would leave the reader on a new message with
  // a stale history still covering it, so the dialog closes and hands the target back.
  it('closes with the target when a permalink inside a version is followed', async () => {
    const { container, close } = await build(
      of({
        revisions: [
          revision({
            html: '<a href="https://matrix.to/#/@bob:hs">Bob</a>',
          }),
        ],
        truncated: false,
      }),
    );

    fireEvent.click(container.querySelector('.revision__text a')!);

    expect(close).toHaveBeenCalledWith({ kind: 'user', userId: '@bob:hs' });
  });

  describe('removing a version', () => {
    /** Your own message with three versions: original, one earlier edit, current. */
    const ownThree = () =>
      of({
        revisions: [
          revision({ id: '$a', body: 'aaa', isOwn: true }),
          revision({ id: '$b', body: 'bbb', isOwn: true }),
          revision({ id: '$c', body: 'ccc', isOwn: true }),
        ],
        truncated: false,
      });

    /**
     * Every version of your own message is removable EXCEPT row 0 — that one is the
     * message itself rather than a revision, and removing it is the timeline's Delete
     * action, after which the history refuses to load at all.
     */
    it('offers removal on each of your own versions but not the message itself', async () => {
      const { container } = await build(ownThree());

      const rows = container.querySelectorAll('.revision');
      expect(rows[0].querySelector('[data-testid=revision-remove]')).toBeNull();
      expect(
        rows[1].querySelector('[data-testid=revision-remove]'),
      ).not.toBeNull();
      expect(
        rows[2].querySelector('[data-testid=revision-remove]'),
      ).not.toBeNull();
    });

    it('offers nothing on someone else’s message', async () => {
      const { container } = await build(
        of({
          revisions: [
            revision({ id: '$a', body: 'aaa' }),
            revision({ id: '$b', body: 'bbb' }),
            revision({ id: '$c', body: 'ccc' }),
          ],
          truncated: false,
        }),
      );

      expect(
        container.querySelectorAll('[data-testid=revision-remove]'),
      ).toHaveLength(0);
    });

    it('offers the one edit of a message edited once, but not its original', async () => {
      const { container } = await build(
        of({
          revisions: [
            revision({ id: '$a', body: 'aaa', isOwn: true }),
            revision({ id: '$b', body: 'bbb', isOwn: true }),
          ],
          truncated: false,
        }),
      );

      const rows = container.querySelectorAll('.revision');
      expect(rows[0].querySelector('[data-testid=revision-remove]')).toBeNull();
      expect(
        rows[1].querySelector('[data-testid=revision-remove]'),
      ).not.toBeNull();
    });

    it('asks before removing, and does nothing if you say no', async () => {
      const { container, remove, confirm } = await build(ownThree());
      confirm.mockResolvedValue(false);

      fireEvent.click(
        container.querySelector('[data-testid=revision-remove]')!,
      );
      await Promise.resolve();

      expect(confirm).toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('redacts the confirmed version and drops its row', async () => {
      const { container, fixture, remove } = await build(ownThree());

      fireEvent.click(
        container.querySelector('[data-testid=revision-remove]')!,
      );
      await waitFor(() => expect(remove).toHaveBeenCalledWith('!r:hs', '$b'));
      fixture.detectChanges();

      expect(container.querySelectorAll('.revision')).toHaveLength(2);
      expect(container.textContent).not.toContain('bbb');
    });

    // Re-reading is not bookkeeping: removing the newest edit leaves the SDK aggregating
    // the message back to its ORIGINAL wording, and re-fetching the relations is what
    // pulls a fresh bundle for the original event and puts the timeline right.
    //
    // The fixture answers the refetch with the PRE-removal list — exactly the stale
    // answer `/relations` can give just after a redaction — so this also proves a late
    // server response cannot put the removed version back.
    it('re-reads the history afterwards, and a stale answer cannot undo the removal', async () => {
      const { container, fixture, revisions, remove } = await build(ownThree());
      expect(revisions).toHaveBeenCalledOnce();

      fireEvent.click(
        container.querySelector('[data-testid=revision-remove]')!,
      );
      await waitFor(() => expect(remove).toHaveBeenCalledWith('!r:hs', '$b'));

      await waitFor(() => expect(revisions).toHaveBeenCalledTimes(2), {
        timeout: 3000,
      });
      fixture.detectChanges();

      expect(container.querySelectorAll('.revision')).toHaveLength(2);
      expect(container.textContent).not.toContain('bbb');
    });

    /**
     * Closing the dialog straight after confirming is the most likely way to use this, and
     * it must not cancel anything: the redaction is in flight, and the re-read that follows
     * it is what repairs the message on the timeline behind the dialog.
     *
     * This is a regression test with a scar. Tying the re-read to the component's lifetime
     * (`takeUntilDestroyed`) looks obviously right, passes every other test here, and
     * leaves the timeline showing the wrong version for anyone who closes the dialog
     * promptly — which only an end-to-end run caught.
     */
    it('finishes the removal and the re-read even if the dialog is closed first', async () => {
      const { container, fixture, revisions, remove } = await build(ownThree());
      remove.mockReturnValue(timer(30).pipe(map(() => undefined)));

      fireEvent.click(
        container.querySelector('[data-testid=revision-remove]')!,
      );
      await waitFor(() => expect(remove).toHaveBeenCalledWith('!r:hs', '$b'));
      fixture.destroy();

      await waitFor(() => expect(revisions).toHaveBeenCalledTimes(2), {
        timeout: 3000,
      });
    });

    // A failure must not blank the list: the dialog's error state replaces everything,
    // and losing the whole history because one row failed is the wrong trade.
    it('keeps the list and says so when the server refuses', async () => {
      const { container, fixture, remove, toast } = await build(ownThree());
      remove.mockReturnValue(throwError(() => new Error('M_FORBIDDEN')));

      fireEvent.click(
        container.querySelector('[data-testid=revision-remove]')!,
      );
      await waitFor(() => expect(toast).toHaveBeenCalled());
      fixture.detectChanges();

      expect(container.querySelectorAll('.revision')).toHaveLength(3);
      expect(
        container.querySelector('[data-testid=edit-history-error]'),
      ).toBeNull();
    });
  });

  it('closes with nothing when dismissed', async () => {
    const { container, close } = await build();

    fireEvent.click(
      container.querySelector('[data-testid=edit-history-close]')!,
    );

    expect(close).toHaveBeenCalledWith(undefined);
  });
});
