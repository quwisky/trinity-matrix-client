import {
  collectHeldSends,
  collectSends,
  pickFiles,
  png,
  renderComposer,
  revokeObjectURL,
  stagedFiles,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ComposerSubmit } from './message-composer.component';
import { type BatchItem, type BatchOutcome } from '../shared/send-media-batch';

describe('MessageComposerComponent — sending a batch and reconciling its outcomes', () => {
  beforeEach(() => stubObjectUrls());

  it('sends every staged file in one press, in the order staged', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectSends(cmp);
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);

    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png', 'three.png']);
    // Delivered items leave the strip — and every preview with them.
    expect(stagedFiles(cmp)).toEqual([]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('keeps the files that failed, and only those', async () => {
    // The reason the batch reports per item rather than throwing: a bad third file must not
    // cost the other four, and what stays in the strip is exactly what to retry.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: item.file.name === 'bad.png',
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('bad.png'), png('three.png')]);

    cmp.submit();

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['bad.png']);
  });

  it('marks the files that failed, and unmarks them when a retry succeeds', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let failNames: string[] = ['bad.png'];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: failNames.includes(item.file.name),
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('bad.png')]);

    cmp.submit();
    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['bad.png']);
    expect(cmp.staged().map((a) => a.failed)).toEqual([true]);

    // The row is not stuck failed: a successful retry clears the flag by leaving. No
    // `uploadProgress` round-trip — outcomes landing is what releases the latch.
    failNames = [];
    cmp.submit();

    expect(stagedFiles(cmp)).toEqual([]);
  });

  it('retries one failed file without re-sending the rest', async () => {
    // Pressing send again retries everything staged, which is wrong once the user has added
    // more files since — the per-row retry is what sends exactly the one that failed.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const batches: string[][] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      batches.push(items.map((item) => item.file.name));
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: item.file.name === 'bad.png',
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('bad.png')]);
    cmp.submit();
    pickFiles(cmp, [png('later.png')]); // added after the failure

    const failedId = cmp.staged().find((a) => a.failed)?.id ?? '';
    cmp['retryStaged'](failedId);

    expect(batches).toEqual([
      ['one.png', 'bad.png'],
      ['bad.png'], // just the one, not `later.png` too
    ]);
    expect(stagedFiles(cmp).map((f) => f.name)).toEqual([
      'bad.png',
      'later.png',
    ]);
  });

  it('posts a batch caption as a plain message, never as the edit in progress', async () => {
    // The window between dispatch and outcomes is the whole upload, and starting an edit in it
    // is an ordinary ungated action. Routed through the composer's CURRENT state, the caption
    // would be applied as the edit — silently rewriting a message already in the room.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const finish: (() => void)[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      finish.push(() =>
        onOutcomes(items.map((item, i) => ({ id: item.id, failed: i > 0 }))),
      );
    });
    const captions: string[] = [];
    const submits: string[] = [];
    cmp.submitBatchCaption.subscribe((e) => captions.push(e.text));
    cmp.submitText.subscribe((e) => submits.push(e.text));
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('check these out');
    cmp.submit();

    // The user starts editing an earlier message while the files upload.
    fixture.componentRef.setInput('editing', true);
    fixture.detectChanges();
    finish[0]?.();

    // It goes out on the channel the host sends plainly — not the one it routes.
    expect(captions).toEqual(['check these out']);
    expect(submits).toEqual([]);
  });

  it('drops a batch caption whose room is no longer open, keeping it as that room’s draft', async () => {
    // `send` resolves the open room on subscribe, so emitting after a switch posts into the
    // NEW conversation. The files are already pinned to their room; the caption was not.
    const { fixture } = await renderComposer({ roomId: '!a:hs' });
    const cmp = fixture.componentInstance;
    const finish: (() => void)[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      finish.push(() =>
        onOutcomes(items.map((item, i) => ({ id: item.id, failed: i > 0 }))),
      );
    });
    const captions: string[] = [];
    cmp.submitBatchCaption.subscribe((e) => captions.push(e.text));
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('here are the photos');
    cmp.submit();

    fixture.componentRef.setInput('roomId', '!b:hs');
    fixture.detectChanges();
    finish[0]?.();

    expect(captions).toEqual([]); // not posted into !b:hs
    expect(cmp.text()).toBe(''); // nor dropped into its composer
    // Not destroyed either: it is waiting where it was written.
    fixture.componentRef.setInput('roomId', '!a:hs');
    fixture.detectChanges();
    expect(cmp.text()).toBe('here are the photos');
  });

  it('does not let Escape clear rows the batch is still reporting on', async () => {
    // The rows stay staged until outcomes land, by design. Clearing them mid-flight leaves a
    // failure with nowhere to go, and the host then promises files are "still in the
    // composer" that the user has just discarded.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined); // in flight
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.submit();

    cmp.onEscape();

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['one.png', 'two.png']);
  });

  it('still lets Escape clear staging when nothing is going out', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png')]);

    cmp.onEscape();

    expect(stagedFiles(cmp)).toEqual([]);
  });

  it('commits the edit, not the staged files, when Enter is pressed mid-edit', async () => {
    // Staging survives entering edit mode (nothing clears it, and only paste/drop/the +
    // trigger are gated on `editing`). Without the gate in `submit()`, Enter would send the
    // files with the EDIT BODY as their caption and never emit `submitText` — so the host
    // would never clear `editingId` and the composer would stay stuck in edit mode.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent: string[] = [];
    const texts: string[] = [];
    cmp.submitMedia.subscribe(({ items }) =>
      sent.push(...items.map((i) => i.file.name)),
    );
    cmp.submitText.subscribe((e) => texts.push(e.text));
    pickFiles(cmp, [png('one.png')]);

    fixture.componentRef.setInput('editing', true);
    fixture.detectChanges();
    cmp.text.set('the corrected wording');
    cmp.submit();

    expect(sent).toEqual([]); // the files stay put
    expect(texts).toEqual(['the corrected wording']); // the edit goes through
    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['one.png']);
  });

  it('carries the mentions typed into a batch caption', async () => {
    // The caption becomes a message in its own right, so its @-mentions have to travel with
    // it — dropped, the people named in it are never pinged.
    const { fixture, container } = await renderComposer({
      members: [{ userId: '@alice:hs', roomDisplayName: 'Alice' }],
    });
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) =>
      onOutcomes(items.map((item) => ({ id: item.id, failed: false }))),
    );
    let carried: ComposerSubmit | undefined;
    cmp.submitBatchCaption.subscribe((e) => (carried = e));
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'over to @al';
    ta.selectionStart = ta.selectionEnd = 11;
    cmp.onInput({ target: ta } as unknown as Event);
    ta.selectionStart = 11;
    cmp.menus.acceptMention();

    cmp.submit();

    expect(carried?.text).toBe('over to @Alice');
    expect(carried?.mentions).toEqual([
      { userId: '@alice:hs', display: '@Alice' },
    ]);
  });

  it('gives the caption back when nothing carried it', async () => {
    // `submit()` clears the box as soon as the batch is dispatched. If every file then fails,
    // the caption rode nothing — and destroying what the user typed is a worse outcome than
    // the failed upload that caused it.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('here are the photos');

    cmp.submit();

    expect(cmp.text()).toBe('here are the photos');
  });

  it('gives back a single file’s caption too, which rode the send that failed', async () => {
    // One file's caption travels ON the media event (MSC2530), so a failed send takes it with
    // it — there is no separate message left holding it.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png')]);
    cmp.text.set('the only one');

    cmp.submit();

    expect(cmp.text()).toBe('the only one');
  });

  it('does not clobber something typed while the batch was going out', async () => {
    // Restoring is for the caption the user lost, not for overwriting the one they are in the
    // middle of writing — outcomes land long after the box was cleared.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const finish: ((outcomes: readonly BatchOutcome[]) => void)[] = [];
    cmp.submitMedia.subscribe(({ onOutcomes }) => finish.push(onOutcomes));
    pickFiles(cmp, [png('one.png')]);
    cmp.text.set('first caption');
    cmp.submit();

    cmp.text.set('second thoughts');
    finish[0]?.([{ id: cmp.staged()[0]?.id ?? '', failed: true }]);

    expect(cmp.text()).toBe('second thoughts');
  });

  it('carries the caption on a per-row retry', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const captions: string[] = [];
    cmp.submitMedia.subscribe(({ caption, items, onOutcomes }) => {
      captions.push(caption);
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();

    cmp.text.set('trying again');
    cmp['retryStaged'](cmp.staged()[0]?.id ?? '');

    expect(captions).toEqual(['', 'trying again']);
  });

  it('leaves the other failed rows marked when one of them is retried', async () => {
    // The flow the retry button exists for. Reporting one item's outcome must not restate the
    // failure state of files that outcome says nothing about.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let failNames = ['one.png', 'two.png', 'three.png'];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: failNames.includes(item.file.name),
        })),
      );
    });
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);
    cmp.submit();
    expect(cmp.staged().map((a) => a.failed)).toEqual([true, true, true]);

    failNames = []; // the retry succeeds
    cmp['retryStaged'](cmp.staged()[0]?.id ?? '');

    expect(cmp.staged().map((a) => a.file.name)).toEqual([
      'two.png',
      'three.png',
    ]);
    expect(cmp.staged().map((a) => a.failed)).toEqual([true, true]);
  });

  it('leaves the failed rows marked when a GIF is sent past them', async () => {
    // A GIF dispatches with a synthetic id that matches nothing staged, so an outcome handler
    // that restates the whole list would wipe every marker in the strip.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      onOutcomes(
        items.map((item) => ({
          id: item.id,
          failed: !item.id.startsWith('direct-'),
        })),
      );
    });
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();
    expect(cmp.staged().map((a) => a.failed)).toEqual([true]);

    // Exactly the call the attachments service's `sendMedia` hook makes for a chosen GIF.
    cmp['batches'].dispatch(
      [{ id: 'direct-cat.gif', file: png('cat.gif') }],
      '',
      [],
    );

    expect(cmp.staged().map((a) => a.failed)).toEqual([true]);
  });

  it('stops showing a retried file as failed while its retry is in flight', async () => {
    // Otherwise the row you just pressed retry on still reads "Not sent" for the whole
    // upload, which is indistinguishable from the press having done nothing.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let hold = false;
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      if (hold) {
        return; // in flight: outcomes have not landed yet
      }
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.submit();
    expect(cmp.staged().map((a) => a.failed)).toEqual([true, true]);

    hold = true;
    cmp['retryStaged'](cmp.staged()[0]?.id ?? '');

    // The retried one is uploading; its sibling has not been touched.
    expect(cmp.staged().map((a) => a.failed)).toEqual([false, true]);
  });

  it('sends a batch caption as its own message, after the files', async () => {
    // Matrix has no multi-attachment event, so there is no first image for a batch caption to
    // belong to, and repeating it on each would put the same sentence in the room N times.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectSends(cmp);
    const texts: string[] = [];
    cmp.submitBatchCaption.subscribe((e) => texts.push(e.text));
    pickFiles(cmp, [png('one.png'), png('two.png')]);
    cmp.text.set('both of these');

    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png']);
    expect(texts).toEqual(['both of these']);
  });

  it('leaves a single file’s caption on the media event', async () => {
    // One file keeps its MSC2530 caption, which is what the existing e2e round-trip asserts.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    let seen: string | undefined;
    cmp.submitMedia.subscribe(({ items, caption, onOutcomes }) => {
      seen = caption;
      onOutcomes(items.map((item) => ({ id: item.id, failed: false })));
    });
    const texts: string[] = [];
    const batchCaptions: string[] = [];
    cmp.submitText.subscribe((e) => texts.push(e.text));
    cmp.submitBatchCaption.subscribe((e) => batchCaptions.push(e.text));
    pickFiles(cmp, [png('one.png')]);
    cmp.text.set('just this one');

    cmp.submit();

    expect(seen).toBe('just this one');
    expect(texts).toEqual([]); // no separate message
    // And not on the batch channel either: one file's caption is IN its event, so posting it
    // again would put the same sentence in the room twice for the commonest attachment flow.
    expect(batchCaptions).toEqual([]);
  });

  it('refuses a second batch while the first is still uploading', async () => {
    // Two batches in flight share one `uploadProgress` — the first to finish nulls it, hiding
    // the bar for the other — and interleave their events, so neither arrives in the order
    // staged. Staging more mid-flight is allowed; starting a second batch is not.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectHeldSends(cmp);
    pickFiles(cmp, [png('one.png')]);

    cmp.submit();
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    }); // the host reports it in flight
    fixture.detectChanges();
    pickFiles(cmp, [png('two.png')]);
    cmp.submit();

    expect(sent).toEqual(['one.png']);
  });

  it('honours current-room progress when mounted during an upload', async () => {
    const { fixture } = await renderComposer({
      roomId: '!current:hs',
      uploadProgress: { index: 1, total: 1, fraction: 0.4 },
    });
    const cmp = fixture.componentInstance;
    const sent = collectHeldSends(cmp);
    pickFiles(cmp, [png('one.png')]);

    cmp.submit();

    expect(sent).toEqual([]);
  });

  it('guards the keyboard path too, and shows the button as disabled', async () => {
    // `onEnter` calls `submit()` directly and never consults `[disabled]`, so the code guard
    // is what stops it — and the button has to SAY so, or the block reads as a dead control.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectHeldSends(cmp);
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    });
    fixture.detectChanges();
    pickFiles(cmp, [png('two.png')]);

    cmp.onEnter(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(sent).toEqual(['one.png']);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid=composer-send]')
        ?.disabled,
    ).toBe(true);
  });

  it('shows which file the upload bar belongs to', async () => {
    // The bar renders above the rows still staged; unlabelled it reads as though it describes
    // them, when it describes the one that just left the list.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    });
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid=upload-progress]')?.textContent,
    ).toContain('one.png');
  });

  it('renders every staged file and removes the one whose × is pressed', async () => {
    // The composer→strip wiring, which nothing covered: `[staged]` bound to an empty array,
    // or the × routed to `clearStaged`, both shipped with the whole suite green — and the
    // second is exactly the batch-wipe this change exists to avoid.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    pickFiles(cmp, [png('one.png'), png('two.png'), png('three.png')]);
    fixture.detectChanges();

    const rows = container.querySelectorAll('[data-testid=composer-pending]');
    expect(rows).toHaveLength(3);

    container
      .querySelectorAll<HTMLElement>('[data-testid=composer-pending-remove]')[1]
      ?.click();
    fixture.detectChanges();

    expect(stagedFiles(cmp).map((f) => f.name)).toEqual([
      'one.png',
      'three.png',
    ]);
  });

  it('does not dispatch twice from two presses in the same task', async () => {
    // The case a held Enter key produces, and the one a guard on `uploadProgress` ALONE
    // cannot catch: that is a signal input fed two component layers up, and a signal input is
    // only written during the parent's change detection. Both presses would read `null`.
    // Deliberately no `detectChanges()` between them — inserting one is what made the earlier
    // version of this test pass against the defect. Outcomes are withheld for the same
    // reason: in production they land when the batch ENDS, so until then the files that the
    // second press would re-send are all still staged.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectHeldSends(cmp);
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png']); // each file once, from the first press
  });

  it('allows the next batch once the first one finishes', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent: string[] = [];
    const finish: ((outcomes: readonly BatchOutcome[]) => void)[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      sent.push(...items.map((item) => item.file.name));
      finish.push(onOutcomes); // held, the way a real upload holds it
    });
    pickFiles(cmp, [png('one.png')]);

    cmp.submit();
    // The bar comes and goes, but it is the host's own report that releases the latch — the
    // bar's value is not always observable, and inferring from it is what stranded it before.
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.3,
    });
    fixture.detectChanges();
    cmp.submit();
    expect(sent).toEqual(['one.png']); // still latched

    fixture.componentRef.setInput('uploadProgress', null);
    fixture.detectChanges();
    cmp.submit();
    expect(sent).toEqual(['one.png']); // the bar clearing is NOT what releases it

    finish[0]?.([{ id: cmp.staged()[0]?.id ?? '', failed: true }]);
    cmp.submit();

    expect(sent).toEqual(['one.png', 'one.png']); // failed, so still staged and resendable
  });

  it('keeps what you typed when a send is refused', async () => {
    // A refusal must leave the composer exactly as it found it. Falling through would clear
    // the caption for a send that never happened — the user's words, gone, with the files
    // still sitting in the strip and nothing to say why.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined); // in flight: outcomes never arrive
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();

    cmp.text.set('a caption I typed');
    cmp.submit(); // refused — a batch is already going out

    expect(cmp.text()).toBe('a caption I typed');
  });

  it('shows the send button as blocked before the progress bar has caught up', async () => {
    // The window the button clause exists for: between the dispatch and the parent's change
    // detection, `uploadProgress` is still null. Reading only that leaves the button live
    // while `submit()` refuses — a control that looks pressable and does nothing.
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined); // in flight: `done` is never called
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    fixture.detectChanges(); // CD runs, but the host has reported nothing yet

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid=composer-send]')
        ?.disabled,
    ).toBe(true);
  });

  it('closes the GIF grid on a send, so it cannot outlive one', async () => {
    // Grid items call `sendMedia` directly and are not disabled while an upload runs, so a
    // grid still open after a send is the last route to two uploads at once.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    cmp.submitMedia.subscribe(() => undefined);
    cmp.gifPickerOpen.set(true);
    pickFiles(cmp, [png('one.png')]);

    cmp.submit();

    expect(cmp.gifPickerOpen()).toBe(false);
  });

  it('releases the latch when a send finishes without the bar ever appearing', async () => {
    // The host brackets an upload with `set(0)` … `finalize(set(null))`, and `sendMedia`
    // completes SYNCHRONOUSLY for a 0-byte file — so the host's signal goes null → 0 → null
    // inside the emit. A signal input only ever takes the value present at change detection,
    // and Angular skips the write entirely when it is `Object.is`-equal, so `uploadProgress`
    // never changes and an effect watching it never re-runs. Releasing on the host's own
    // report is what makes the latch independent of whether that value was ever observable.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent: string[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) => {
      sent.push(...items.map((item) => item.file.name));
      // Settled before the emit returned; both files failed, so both stay staged.
      onOutcomes(items.map((item) => ({ id: item.id, failed: true })));
    });
    pickFiles(cmp, [png('one.png'), png('two.png')]);

    cmp.submit();
    cmp.submit();

    expect(sent).toEqual(['one.png', 'two.png', 'one.png', 'two.png']);
  });

  it('does not strand the latch when the room changes mid-upload', async () => {
    // The upload belongs to the page and survives the switch, but nothing staged here does —
    // holding the latch would mute the next room's composer for an upload it cannot see.
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const sent = collectSends(cmp);
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();

    fixture.componentRef.setInput('roomId', '!other:hs');
    fixture.detectChanges();
    pickFiles(cmp, [png('elsewhere.png')]);
    cmp.submit();

    expect(sent).toEqual(['one.png', 'elsewhere.png']);
  });

  it('does not let an old room’s outcomes release the newer room’s batch', async () => {
    const { fixture } = await renderComposer();
    const cmp = fixture.componentInstance;
    const batches: {
      items: readonly BatchItem[];
      onOutcomes: (outcomes: readonly BatchOutcome[]) => void;
    }[] = [];
    cmp.submitMedia.subscribe(({ items, onOutcomes }) =>
      batches.push({ items, onOutcomes }),
    );
    pickFiles(cmp, [png('one.png')]);
    cmp.submit();
    fixture.componentRef.setInput('uploadProgress', {
      index: 1,
      total: 1,
      fraction: 0.4,
    });
    fixture.detectChanges();

    fixture.componentRef.setInput('roomId', '!other:hs');
    fixture.detectChanges();
    pickFiles(cmp, [png('elsewhere.png')]);
    cmp.submit();
    expect(batches.map(({ items }) => items[0]?.file.name)).toEqual([
      'one.png',
      'elsewhere.png',
    ]);

    const first = batches[0];
    first?.onOutcomes(
      first.items.map((item) => ({ id: item.id, failed: false })),
    );

    expect(stagedFiles(cmp).map((file) => file.name)).toEqual([
      'elsewhere.png',
    ]);
    cmp.submit();
    expect(batches).toHaveLength(2); // the second batch still owns the latch

    const second = batches[1];
    fixture.componentRef.setInput('uploadProgress', null);
    fixture.detectChanges();
    second?.onOutcomes(
      second.items.map((item) => ({ id: item.id, failed: true })),
    );
    cmp.submit();
    expect(batches).toHaveLength(3); // its own outcome releases the latch normally
  });
});
