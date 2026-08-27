import { test, expect, type APIRequestContext } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the notification half of quoting: carrying someone else's words must not notify
// the people those words happen to name.
//
// The legacy push rules `.m.rule.contains_display_name` and `.m.rule.roomnotif` match on
// the plain-text `body`, and a quote puts the quoted text there verbatim — so quoting
// "Bob, can you look at this?" used to give Bob a second highlight for a message that
// addresses nobody. A homeserver skips those rules for any event carrying `m.mentions`, so
// the client now always sends that key (message-content.ts).
//
// Asserted through the real client and the real server, because this is entirely the
// server's push evaluation: nothing here is re-implemented locally. Reading the server's
// push-rule JSON is actively misleading — Synapse 1.119 still lists both legacy rules as
// enabled with their original conditions and applies the m.mentions exclusion inside its
// evaluator instead. Only sending a message and looking at the result settles it.
//
// The reader's unread badge is the honest observable end, exactly as in
// keyword-notifications.spec.mts: a desktop notification cannot be seen from Playwright,
// but `.channel__badge` (not `--muted`) is driven by the same `highlight` tweak.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

/** A display name nothing else could match, so a highlight can only be the mention rule. */
const READER_DISPLAY_NAME = 'Zephyrine';

async function loginApi(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<{ token: string; userId: string }> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return { token: json.access_token as string, userId: json.user_id as string };
}

test.describe('Quoting does not notify the people it quotes', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a quoted display name gives the reader no highlight', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}qm`;
    const writer = `qmw-${runId}`;
    const reader = `qmr-${runId}`;
    const pass = `${runId}-pass`;
    const roomName = `Quote mentions ${runId}`;

    await registerUser(request, writer, pass);
    await registerUser(request, reader, pass);
    const w = await loginApi(request, hs, writer, pass);
    const r = await loginApi(request, hs, reader, pass);
    const wHeaders = { Authorization: `Bearer ${w.token}` };
    const rHeaders = { Authorization: `Bearer ${r.token}` };

    // The reader is called Zephyrine — the name the writer will end up quoting.
    await request.put(
      `${hs}/_matrix/client/v3/profile/${r.userId}/displayname`,
      { headers: rHeaders, data: { displayname: READER_DISPLAY_NAME } },
    );

    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: wHeaders,
        data: { name: roomName, preset: 'private_chat', invite: [r.userId] },
      })
      .then((res) => res.json())
      .then((j) => j.room_id as string);
    await request.post(`${hs}/_matrix/client/v3/rooms/${roomId}/join`, {
      headers: rHeaders,
    });

    // A message naming the reader, sent by the reader themselves so that quoting it is the
    // only thing that can put their name in someone else's message body.
    const named = `${READER_DISPLAY_NAME}, can you look at this?`;
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}-src`,
      { headers: rHeaders, data: { msgtype: 'm.text', body: named } },
    );

    // The writer quotes it through the UI and answers.
    await login(page, {
      available: true,
      hs,
      user: writer,
      pass,
    } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    const row = page.locator('.scroll .msg', { hasText: named });
    await expect(row.first()).toBeVisible({ timeout: 30_000 });
    // Hover and click as one retried step, rather than two statements. The ⋮ is
    // hover-revealed, and this room has a second member still syncing, so the timeline can
    // re-render underneath: Angular replaces the row element, the pointer has not moved,
    // and CSS :hover no longer applies to the new node. click() then waits out its whole
    // timeout on a button that will never become visible — which is exactly how this
    // spec flaked in CI ("215 × waiting for element to be visible, enabled and stable").
    // Retrying re-hovers whatever row is current.
    await expect(async () => {
      await row.first().hover();
      await row.first().getByTestId('msg-more').click({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByTestId('msg-quote').click();

    const composer = page.getByTestId('composer-input');
    await expect(composer).toHaveValue(`> ${named}\n\n`, { timeout: 10_000 });
    const answer = `on it ${runId}`;
    await composer.pressSequentially(answer);
    await composer.press('Enter');
    await expect(
      page.locator('.scroll .msg', { hasText: answer }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // Now ask the SERVER what it decided for the reader. An incremental sync is required:
    // a full sync reports zeroes for a room with no read receipt, which silently turns
    // this assertion into a tautology.
    const since = await request
      .get(`${hs}/_matrix/client/v3/sync?timeout=0`, { headers: rHeaders })
      .then((res) => res.json())
      .then((j) => j.next_batch as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}-probe`,
      { headers: wHeaders, data: { msgtype: 'm.text', body: `poke ${runId}` } },
    );
    // Poll until the probe lands in the reader's incremental sync.
    let counts = { notification_count: 0, highlight_count: 0 };
    await expect
      .poll(
        async () => {
          const sync = await request
            .get(`${hs}/_matrix/client/v3/sync?since=${since}&timeout=0`, {
              headers: rHeaders,
            })
            .then((res) => res.json());
          const unread = sync?.rooms?.join?.[roomId]?.unread_notifications;
          if (unread) {
            counts = unread;
          }
          return counts.notification_count;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // The plain "poke" (asserted above) proves the room notifies at all, so a zero
    // highlight here is a decision rather than a room that happened to be silent.
    expect(counts.highlight_count).toBe(0);
  });
});
