import { testResourceId, test, expect } from '../fixtures.mts';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// Covers the edit history: the "(edited)" marker (message-row `data-testid="msg-edited"`)
// opens a dialog listing every version of a message, oldest first.
//
// Seeded over the Client-Server API rather than through the composer, because the point
// under test is what the client does with a chain of `m.replace` events — building that
// chain by hand keeps the versions and their order deterministic. Also asserts the
// deleted-message rule, which is the one case where the marker must NOT be offered.
// Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

test.describe('Edit history', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows every version of an edited message, oldest first', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}eh`;
    const user = `edits-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Edits ${runId}`;
    const versions = [
      `first draft ${runId}`,
      `second draft ${runId}`,
      `final wording ${runId}`,
    ];
    const deletedBody = `deleted message ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const headers = { Authorization: `Bearer ${access_token}` };

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    const room = encodeURIComponent(room_id);

    /** Send `content` and return the event id — sibling specs discard it; here it is the
     *  whole point, since every edit has to point at it. */
    const send = async (
      txn: string,
      content: Record<string, unknown>,
    ): Promise<string> => {
      const { event_id } = await request
        .put(
          `${hs}/_matrix/client/v3/rooms/${room}/send/m.room.message/${txn}`,
          { headers, data: content },
        )
        .then((r) => r.json());
      return event_id as string;
    };

    /** The wire shape of an edit: a "* " fallback body plus the replacement content. */
    const edit = (target: string, body: string) => ({
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: target },
    });

    const original = await send(`${runId}-orig`, {
      msgtype: 'm.text',
      body: versions[0],
    });
    await send(`${runId}-edit1`, edit(original, versions[1]));
    await send(`${runId}-edit2`, edit(original, versions[2]));

    // A formatted message, edited inside its bold run. Only a real browser run puts the
    // whole chain together — formatted_body through the sanitizer, into the annotator,
    // back out through Angular's own sanitizer on [innerHTML] — so this is where "the
    // highlight lands inside the formatting, and both survive" is actually proven.
    const formatted = await send(`${runId}-fmt`, {
      msgtype: 'm.text',
      body: `deploy on Friday ${runId}`,
      format: 'org.matrix.custom.html',
      formatted_body: `deploy on <strong>Friday</strong> ${runId}`,
    });
    await send(`${runId}-fmt-edit`, {
      msgtype: 'm.text',
      body: `* deploy on Monday ${runId}`,
      'm.new_content': {
        msgtype: 'm.text',
        body: `deploy on Monday ${runId}`,
        format: 'org.matrix.custom.html',
        formatted_body: `deploy on <strong>Monday</strong> ${runId}`,
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: formatted },
    });

    // A second message that is edited and then deleted: its edits survive on the server,
    // so this is what proves Trinity refuses to hand them back.
    const doomed = await send(`${runId}-doomed`, {
      msgtype: 'm.text',
      body: deletedBody,
    });
    await send(`${runId}-doomed-edit`, edit(doomed, `${deletedBody} (edited)`));
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${room}/redact/${encodeURIComponent(doomed)}/${runId}-redact`,
      { headers, data: {} },
    );

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession);
    // A named, non-DM room is listed under the Rooms view rather than Home's DMs.
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await expect(channel).toBeVisible({ timeout: 30_000 });
    await channel.click();

    // The timeline shows the latest wording, with no trace of the earlier drafts.
    const row = page.locator(`[data-mid="${original}"]`);
    await expect(row.locator('.msg__text')).toHaveText(versions[2], {
      timeout: 30_000,
    });

    // The marker is a real button whose name keeps the visible word, so it is reachable
    // by voice and by keyboard, not just by mouse.
    const marker = row.getByRole('button', { name: /edited/i });
    await expect(marker).toBeVisible({ timeout: 20_000 });
    await marker.click();

    const dialog = page.getByTestId('edit-history');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.locator('.revision')).toHaveCount(3, {
      timeout: 20_000,
    });
    // Oldest first, and only the ends are named.
    await expect(dialog.locator('.revision__label')).toHaveText([
      'Original',
      'Edited',
      'Current version',
    ]);
    // Each version shows what that edit changed: the words it added are marked, and the
    // words it replaced are struck through beside them.
    // Joined rather than matched one by one: how many marks a change splits into is the
    // diff's business, what they say is the assertion.
    const current = dialog.locator('.revision').last();
    await expect(current.locator('ins.diff-ins').first()).toBeVisible();
    const added = (
      await current.locator('ins.diff-ins').allTextContents()
    ).join(' ');
    const removed = (
      await current.locator('del.diff-del').allTextContents()
    ).join(' ');
    expect(added).toContain('final');
    expect(removed).toContain('second');
    // The original has nothing to compare against.
    await expect(
      dialog.locator('.revision').first().locator('.diff-ins'),
    ).toHaveCount(0);

    // Turning highlighting off gives back the message exactly as it was sent.
    const toggle = page.getByTestId('edit-history-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.locator('.diff-ins')).toHaveCount(0);
    await expect(dialog.locator('.revision__text')).toHaveText(versions);

    await toggle.click();
    await expect(dialog.locator('ins.diff-ins').first()).toBeVisible();
    await expect(page.getByTestId('edit-history-error')).toHaveCount(0);
    // The list is complete, so it must not claim otherwise.
    await expect(page.getByTestId('edit-history-truncated')).toHaveCount(0);

    await page.getByTestId('edit-history-close').click();
    await expect(dialog).toBeHidden();

    // The formatted message: its highlight sits INSIDE the bold run, and the bold still
    // reads as the whole word — the mark was woven into the rendered markup, not pasted
    // over it. Character-level, so "Friday" → "Monday" marks only the letters that moved.
    const formattedRow = page.locator(`[data-mid="${formatted}"]`);
    await formattedRow.getByRole('button', { name: /edited/i }).click();
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const latest = dialog.locator('.revision').last();
    await expect(latest.locator('strong ins.diff-ins')).toHaveText('Mon');
    // The struck letters sit inside the bold too — removed text has no formatting of its
    // own and takes that of wherever it is re-inserted. Hence "FriMonday" while
    // highlighting is on.
    await expect(latest.locator('strong del.diff-del')).toHaveText('Fri');
    await expect(latest.locator('strong')).toContainText('day');

    // ...and with highlighting off the row is the message exactly as sent: bold intact,
    // nothing struck through, no trace of the earlier wording.
    await page.getByTestId('edit-history-toggle').click();
    await expect(latest.locator('strong')).toHaveText('Monday');
    await expect(latest.locator('.diff-ins, .diff-del')).toHaveCount(0);
    await expect(latest).not.toContainText('Fri ');

    await page.getByTestId('edit-history-close').click();
    await expect(dialog).toBeHidden();

    // Removing your own versions. Every row but the first offers it — the first is the
    // message itself, which is the timeline's Delete action, not a revision.
    await marker.click();
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.locator('.revision')).toHaveCount(3);
    await expect(dialog.getByTestId('revision-remove')).toHaveCount(2);
    await expect(
      dialog.locator('.revision').first().getByTestId('revision-remove'),
    ).toHaveCount(0);

    // Remove the CURRENT version — the case that needs repairing. Left alone, the SDK
    // re-aggregates the message back to its ORIGINAL wording rather than the version
    // before it, and drops the "(edited)" marker with it.
    await dialog
      .locator('.revision')
      .last()
      .getByTestId('revision-remove')
      .click();
    // The app's standard destructive confirm, nested inside the dialog. Targeted by its
    // own test id: "Remove" also matches the per-row buttons behind it.
    await page.getByTestId('alert-confirm').click();
    await expect(dialog.locator('.revision')).toHaveCount(2, {
      timeout: 20_000,
    });
    await expect(dialog).not.toContainText(versions[2]);
    // The list did not collapse into an error because one row went away.
    await expect(page.getByTestId('edit-history-error')).toHaveCount(0);
    await page.getByTestId('edit-history-close').click();
    await expect(dialog).toBeHidden();

    // THE POINT: the message now reads as the version before the one removed — not as
    // its original — and it is still marked as edited, so the history is still reachable.
    await expect(row.locator('.msg__text')).toHaveText(versions[1], {
      timeout: 20_000,
    });
    await expect(row.getByRole('button', { name: /edited/i })).toBeVisible();

    // And it stuck server-side: reopening refetches, and the removed version is gone
    // there too rather than merely hidden in this dialog's local state.
    await marker.click();
    await expect(dialog.locator('.revision')).toHaveCount(2, {
      timeout: 20_000,
    });
    await expect(dialog).not.toContainText(versions[2]);
    await expect(dialog).toContainText(versions[1]);

    // Remove the last remaining edit and the message is simply not edited any more: it
    // reads as it was first sent, and the marker goes with it — correctly this time,
    // because there is genuinely no history left to reach.
    await dialog
      .locator('.revision')
      .last()
      .getByTestId('revision-remove')
      .click();
    await page.getByTestId('alert-confirm').click();
    await expect(dialog.locator('.revision')).toHaveCount(1, {
      timeout: 20_000,
    });
    await page.getByTestId('edit-history-close').click();
    await expect(dialog).toBeHidden();

    await expect(row.locator('.msg__text')).toHaveText(versions[0], {
      timeout: 20_000,
    });
    await expect(row.getByTestId('msg-edited')).toHaveCount(0);

    // Deleting a message takes its history with it, even though the m.replace events are
    // still on the server — no marker, so no way to ask for them.
    //
    // Note this holds here for two reasons, and only one is ours: the SDK also drops its
    // own edit flag when it applies a redaction it saw live, which is this flow. The
    // component guard is what covers an event that arrives ALREADY redacted (backfill,
    // where there is no redaction event to apply), and message-row.component.spec.ts is
    // what pins that — this assertion locks the user-visible rule, not the mechanism.
    const deletedRow = page.locator(`[data-mid="${doomed}"]`);
    await expect(deletedRow).toBeVisible({ timeout: 20_000 });
    await expect(deletedRow.getByTestId('msg-edited')).toHaveCount(0);
    await expect(deletedRow).not.toContainText(deletedBody);
  });
});
