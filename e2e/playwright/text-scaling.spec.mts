import { test, expect, type Page } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';
import { openSettingsSection } from './journeys/navigation.mts';

// Covers the text-size setting (Settings → Appearance → Text size). The lever is the ROOT
// font size, applied as a percentage, so everything that inherits from it scales.
//
// The assertion that matters is the COMPUTED size of a real message, not the value on
// <html>. `.msg__text` consumes a root-relative semantic message role, but that is a
// stylesheet contract and can drift. Asserting the root alone would keep passing if a
// component later hard-coded a size onto the message body, which is exactly the regression
// this setting exists to avoid.
//
// It also pins the deliberate LIMIT: chrome that hard-codes px does not scale (147 such
// declarations remain, to be converted surface by surface), so the setting's own note says
// so. This asserts the sidebar room name stays fixed — if that ever changes, the note is
// wrong and should be removed with it.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

/** Pick an option from one of the Appearance selects (a CDK overlay). */
async function choose(
  page: Page,
  select: string,
  option: string,
): Promise<void> {
  await page.getByTestId(select).locator('button').first().click();
  const item = page.getByTestId(option);
  await item.waitFor({ state: 'visible', timeout: 15_000 });
  await item.click();
  await expect(item).toHaveCount(0);
}

/**
 * Back to the room after visiting Settings.
 *
 * A full navigation, and it has to be: Settings is its own route and the server rail lives
 * in the rooms feature, so there is no in-app control to click back with. Each of these
 * therefore costs a cold boot — Rust-crypto init plus a first /sync, which this config
 * budgets at 15-40s under load — and that, not any race, is what puts these specs closest
 * to the 120s ceiling. Worth knowing before adding another settings round-trip to them.
 */
async function backToRoom(page: Page, roomName: string): Promise<void> {
  await page.goto('/rooms');
  await openRoom(page, roomName);
}

const px = (locator: ReturnType<Page['locator']>) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

const lineHeightPx = (locator: ReturnType<Page['locator']>) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));

/**
 * The room-list column and the chat column must butt up against each other: no overlap
 * (which hides controls) and no gap (which is just wrong). Measured from the live boxes
 * rather than from the CSS, because the bug was a unit mismatch between a rem slot and its
 * px contents — something no stylesheet reading makes obvious.
 */
async function expectColumnsMeet(page: Page, label = 'larger'): Promise<void> {
  const list = await page.locator('.sidebar').first().boundingBox();
  const chat = await page.locator('.main').first().boundingBox();
  if (!list || !chat) {
    throw new Error(`columns not rendered at ${label}`);
  }
  // A sub-pixel tolerance only: fractional layout is fine, 44px of overlap is not.
  expect(Math.abs(list.x + list.width - chat.x), label).toBeLessThan(2);
}

test.describe('Text size', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('scales message text, persists, and leaves fixed chrome alone', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ts`;
    const user = `scale-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Scale ${runId}`;
    const body = `readable text ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}`,
      { headers, data: { msgtype: 'm.text', body } },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const message = page.locator('.msg__text', { hasText: body }).first();
    await expect(message).toBeVisible({ timeout: 20_000 });
    const roomNameEl = page.locator('.channel__name').first();

    const before = await px(message);
    const lineHeightBefore = await lineHeightPx(message);
    const chromeBefore = await px(roomNameEl);
    expect(before).toBe(16);
    expect(lineHeightBefore).toBe(24);
    // The default must leave <html> untouched, so the browser's own setting still wins.
    expect(
      await page.evaluate(() => document.documentElement.style.fontSize),
    ).toBe('');

    await openSettingsSection(page, 'appearance');
    const previewBody = page.locator('.preview__body');
    await expect(previewBody).toBeVisible();
    expect(await px(previewBody)).toBe(before);
    expect(await lineHeightPx(previewBody)).toBe(lineHeightBefore);
    await choose(page, 'text-scale-select', 'text-scale-larger');

    expect(await px(previewBody)).toBe(20);
    expect(await lineHeightPx(previewBody)).toBe(30);

    expect(
      await page.evaluate(() => document.documentElement.style.fontSize),
    ).toBe('125%');

    // Back to the room: the MESSAGE is actually bigger. This is the whole claim — the root
    // value alone would pass even if the body had its own hard-coded size.
    await page.goto('/rooms');
    await openRoom(page, roomName);
    const scaled = page.locator('.msg__text', { hasText: body }).first();
    await expect(scaled).toBeVisible({ timeout: 20_000 });
    expect(await px(scaled)).toBeGreaterThan(before);

    // The documented limit: sidebar chrome hard-codes px and deliberately does not scale.
    expect(await px(page.locator('.channel__name').first())).toBe(chromeBefore);

    // The columns still MEET. Tailwind's `w-*` are rem, so the list column's slot scales
    // with the root while the rail (72px) and sidebar (280px) inside it do not — as
    // `md:w-88` the slot shrank to 308px at Small and the chat column painted over the room
    // list, clipping the filter box and every row's ⋮ out of reach. Asserting font sizes
    // alone would never have seen it.
    await expectColumnsMeet(page);

    // Every step, not just the one above: the overlap was worst at Small, which a test that
    // only ever picked Larger would have missed entirely.
    for (const step of ['small', 'default', 'large'] as const) {
      await openSettingsSection(page, 'appearance');
      await choose(page, 'text-scale-select', `text-scale-${step}`);
      await page.goto('/rooms');
      await openRoom(page, roomName);
      await expectColumnsMeet(page, step);
    }

    await openSettingsSection(page, 'appearance');
    await choose(page, 'text-scale-select', 'text-scale-larger');
    await page.goto('/rooms');
    await openRoom(page, roomName);

    // Persisted, not session state.
    await page.reload();
    await openRoom(page, roomName);
    const afterReload = page.locator('.msg__text', { hasText: body }).first();
    await expect(afterReload).toBeVisible({ timeout: 20_000 });
    expect(await px(afterReload)).toBeGreaterThan(before);
  });
});

/**
 * Code size (Settings → Appearance → Code size) — a second, independent axis.
 *
 * The point of the setting is that it moves code WITHOUT moving anything else, and that it
 * composes with Text size rather than replacing it. Neither claim can be read off the
 * stylesheet: both are properties of how two relative values multiply at runtime, so this
 * measures real rendered elements at each combination, as the Text size test above does.
 */
test.describe('Code size', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('sizes code without moving prose, and composes with Text size', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}cs`;
    const user = `code-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Code ${runId}`;
    const body = `prose ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    // Prose and a fenced block in ONE message, so both are measured in the same inherited
    // context and the ratio between them means something.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: `${body}\n\n    def greet(n):`,
          format: 'org.matrix.custom.html',
          formatted_body: `<p>${body}</p><pre><code class="language-python">def greet(n):</code></pre>`,
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const prose = page.locator('.msg__text--html p', { hasText: body }).first();
    const code = page.locator('.msg__text--html pre code').first();
    await expect(code).toBeVisible({ timeout: 20_000 });

    const proseDefault = await px(prose);
    const codeDefault = await px(code);
    // The optical correction, and the default leaving no footprint on <html>.
    expect(codeDefault / proseDefault).toBeCloseTo(0.85, 2);
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--trinity-code-scale'),
      ),
    ).toBe('');

    await openSettingsSection(page, 'appearance');
    await choose(page, 'code-scale-select', 'code-scale-larger');
    await backToRoom(page, roomName);

    const proseLarger = await px(prose);
    const codeLarger = await px(code);
    // The whole point: code grew, and the prose beside it did not budge. A setting that
    // moved both would be Text size wearing a different label.
    expect(codeLarger).toBeGreaterThan(codeDefault);
    expect(proseLarger).toBeCloseTo(proseDefault, 3);

    // Now the composition. Text size moves the root; code must follow it AND keep the
    // enlargement, so the ratio between the two survives. If the code size were absolute,
    // this ratio would collapse back towards the correction.
    await openSettingsSection(page, 'appearance');
    await choose(page, 'text-scale-select', 'text-scale-larger');
    await backToRoom(page, roomName);

    const proseBoth = await px(prose);
    const codeBoth = await px(code);
    expect(proseBoth).toBeGreaterThan(proseDefault);
    expect(codeBoth / proseBoth).toBeCloseTo(codeLarger / proseLarger, 2);

    // Persisted, not session state.
    await page.reload();
    await openRoom(page, roomName);
    await expect(code).toBeVisible({ timeout: 20_000 });
    expect(await px(code)).toBeCloseTo(codeBoth, 1);
  });
});

/**
 * Line numbers (Settings → Appearance → Line numbers).
 *
 * The hard constraint is that the numbers are not text: they must not be selectable, must
 * not be copied, and must never reach the edit-history diff, which compares the TEXT of two
 * rendered revisions. That is unobservable in a unit test — the numbers are generated
 * content, which only exists once a browser has applied a stylesheet.
 *
 * The `rows` attribute is the other thing only a browser can confirm. Angular's [innerHTML]
 * sanitizer runs again at the render leaf against a fixed allowlist, and an attribute it
 * does not admit is dropped silently; the unit tests parse the sanitizer's own string output
 * and would stay green through that.
 */
test.describe('Code line numbers', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('numbers long blocks only, and never as part of the text', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ln`;
    const user = `lines-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Lines ${runId}`;
    const short = `s${runId} = 1`;
    const long = Array.from({ length: 8 }, (_, i) => `line_${i} = ${i}`).join(
      '\n',
    );

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    const send = (txn: string, source: string) =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${txn}`,
        {
          headers,
          data: {
            msgtype: 'm.text',
            body: source,
            format: 'org.matrix.custom.html',
            formatted_body: `<pre><code class="language-python">${source}</code></pre>`,
          },
        },
      );
    await send(`${runId}a`, short);
    await send(`${runId}b`, long);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const shortBlock = page
      .locator('.msg__text--html pre', { hasText: short })
      .first();
    const longBlock = page
      .locator('.msg__text--html pre', { hasText: 'line_7' })
      .first();
    await expect(longBlock).toBeVisible({ timeout: 20_000 });

    // `rows` survives Angular's second sanitizer pass. An attribute it dropped would leave
    // every assertion below silently unnumbered.
    await expect(longBlock.locator('code')).toHaveAttribute('rows', '8');
    expect(await shortBlock.locator('code').getAttribute('rows')).toBeNull();

    const firstNumber = (block: ReturnType<Page['locator']>) =>
      block.evaluate(
        (el) =>
          getComputedStyle(
            el.querySelector('.code-line') as Element,
            '::before',
          ).content,
      );

    // Default: the long block is numbered, the short one is not.
    expect(await firstNumber(longBlock)).toContain('counter');
    expect(await firstNumber(shortBlock)).toBe('none');

    // The numbering has to END where the block does. The rendered digit itself is not
    // reachable — `content` computes to the unresolved `counter(code-line)` — but the
    // counter increments once per wrapper, so wrapper count against the declared `rows` is
    // the same statement. This is what the trailing newline broke: it wrapped one line more
    // than the block has, numbering a blank row past the last line of code.
    const wrappers = await longBlock.locator('.code-line').count();
    expect(String(wrappers)).toBe(
      await longBlock.locator('code').getAttribute('rows'),
    );

    // THE constraint. The numbers are generated content, so the block reads as its source
    // and nothing else — no digits in the text, and the <pre> matches its <code> exactly.
    const text = await longBlock.evaluate((el) => el.textContent ?? '');
    expect(text).toBe(long);

    await openSettingsSection(page, 'appearance');
    await choose(page, 'code-lines-select', 'code-lines-always');
    await backToRoom(page, roomName);

    // `always` reaches the short block, which carries no `rows` — proof the preference is
    // applied in CSS rather than baked into the memoized markup.
    await expect(shortBlock).toBeVisible({ timeout: 20_000 });
    expect(await firstNumber(shortBlock)).toContain('counter');
    expect(await shortBlock.locator('code').getAttribute('rows')).toBeNull();

    await openSettingsSection(page, 'appearance');
    await choose(page, 'code-lines-select', 'code-lines-off');
    await backToRoom(page, roomName);

    await expect(longBlock).toBeVisible({ timeout: 20_000 });
    expect(await firstNumber(longBlock)).toBe('none');
    // Off is a real state, not the absence of one: the attribute is what overrides `rows`.
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute('data-code-lines'),
      ),
    ).toBe('off');
  });

  test('keeps the gutter one width as the line count gains a digit', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}gw`;
    const user = `gutter-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Gutter ${runId}`;
    // Past line 9 on purpose: the gutter used to size to each number's own digits, so the
    // column — and every line of code after it — stepped right by one character the moment
    // the count reached two digits. Twelve lines straddles that boundary; the jump at 100
    // is the same mechanism, and a 100-line block is not worth the round trip.
    const source = Array.from(
      { length: 12 },
      (_, i) => `line_${i} = ${i}`,
    ).join('\n');

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}a`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: source,
          format: 'org.matrix.custom.html',
          formatted_body: `<pre><code class="language-python">${source}</code></pre>`,
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const block = page
      .locator('.msg__text--html pre', { hasText: 'line_11' })
      .first();
    await expect(block).toBeVisible({ timeout: 20_000 });
    await expect(block.locator('code')).toHaveAttribute('rows', '12');

    // Where each line's own text starts. The digits are generated content and so are not in
    // the DOM, but a Range over the wrapper's contents begins after them — which makes this
    // the position the gutter's width actually controls, and the one a reader sees jog.
    const starts = await block.evaluate((el) =>
      [...el.querySelectorAll('.code-line')].map((line) => {
        const range = document.createRange();
        range.selectNodeContents(line);
        return Math.round(range.getBoundingClientRect().left);
      }),
    );

    expect(starts).toHaveLength(12);
    expect(new Set(starts).size).toBe(1);
  });
});
