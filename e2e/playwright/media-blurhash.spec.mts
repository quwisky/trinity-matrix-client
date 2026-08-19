import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// MSC2448 blurhash placeholders: an image arrives with a ~30-character encoding of its own
// colours, and the client paints that behind the box while the real bytes are still in
// flight. Everything here needs a browser — the decode goes through a canvas, which jsdom
// does not implement, so a component spec can only ever observe the fallback.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

/** The canonical example from the blurhash reference implementation: 4x3 components. */
const VALID_HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

/** Same string with one character replaced by `!`, which is outside the base83 alphabet. */
const MALFORMED_HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdn!';

/** A real, decodable 1x1 PNG, so the send round-trips genuine image bytes. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

/** The box a given image message reserved. */
const boxFor = (page: Page, filename: string) =>
  page
    .locator('.media--image', { has: page.locator(`img[alt="${filename}"]`) })
    .first();

/** The `background-image` on that box. */
const backgroundOf = (page: Page, filename: string) =>
  boxFor(page, filename).evaluate((el) => getComputedStyle(el).backgroundImage);

/**
 * How the placeholder is DRAWN, and what colour it actually is.
 *
 * Asserting that a data URL is present is not enough, and both halves of this have already
 * been wrong in this branch:
 *
 * - The sizing longhands were reset by a later `background:` shorthand, so the 32x32 decode
 *   tiled across the box as a mosaic. The URL was correct throughout, so a check on
 *   `backgroundImage` alone stayed green.
 * - A prefix match on `data:image/png` is satisfied by a fully transparent PNG, so a decoder
 *   that serialised the canvas before painting it would look identical to a working one.
 *
 * So the URL is loaded back into a canvas here and a real pixel is read out of it.
 */
async function placeholderOf(
  page: Page,
  filename: string,
): Promise<{
  size: string;
  repeat: string;
  centre: [number, number, number, number];
}> {
  return boxFor(page, filename).evaluate(async (el) => {
    const style = getComputedStyle(el);
    const url = style.backgroundImage.slice(5, -2); // strip url(" ")
    const bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('placeholder did not decode'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('no 2d context to read the placeholder back with');
    }
    context.drawImage(bitmap, 0, 0);
    const middle = context.getImageData(
      Math.floor(bitmap.width / 2),
      Math.floor(bitmap.height / 2),
      1,
      1,
    ).data;
    return {
      size: style.backgroundSize,
      repeat: style.backgroundRepeat,
      centre: [middle[0], middle[1], middle[2], middle[3]] as [
        number,
        number,
        number,
        number,
      ],
    };
  });
}

test.describe('Blurhash placeholders', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('paints the hash it is sent, and ignores one it cannot trust', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}bh`;
    const user = `blur-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Blur ${runId}`;

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

    const mxc = await request
      .post(`${hs}/_matrix/media/v3/upload?filename=dot.png`, {
        headers: { ...headers, 'Content-Type': 'image/png' },
        data: PNG_1x1,
      })
      .then((r) => r.json())
      .then((j) => j.content_uri as string);

    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    /** Send an `m.image` whose `info` carries whatever blurhash we are testing. */
    const sendImage = (txn: string, body: string, blurhash?: string) =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${txn}`,
        {
          headers,
          data: {
            msgtype: 'm.image',
            body,
            url: mxc,
            info: {
              mimetype: 'image/png',
              w: 320,
              h: 180,
              ...(blurhash ? { 'xyz.amorgan.blurhash': blurhash } : {}),
            },
          },
        },
      );

    const withHash = `hashed-${runId}.png`;
    const without = `plain-${runId}.png`;
    const malformed = `broken-${runId}.png`;
    const overlong = `long-${runId}.png`;

    await sendImage(`${runId}a`, withHash, VALID_HASH);
    await sendImage(`${runId}b`, without);
    await sendImage(`${runId}c`, malformed, MALFORMED_HASH);
    // Comfortably past the 200-character cap the projection enforces, and still legal
    // base83, so only the LENGTH can be what rejects it.
    await sendImage(`${runId}d`, overlong, VALID_HASH.padEnd(400, '0'));

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await expect(page.locator(`img[alt="${overlong}"]`)).toBeVisible({
      timeout: 30_000,
    });

    // THE claim: a hash the sender supplied is decoded and painted onto the box that
    // reserved the space. A data URL, because the decode happens in a detached canvas.
    expect(await backgroundOf(page, withHash)).toMatch(
      /^url\("data:image\/png/,
    );

    // …and it is drawn as ONE stretched image, carrying real colour.
    const painted = await placeholderOf(page, withHash);
    expect(painted.size).toBe('100% 100%');
    expect(painted.repeat).toBe('no-repeat');
    // Opaque, and not the black or white a blank canvas would give. `LEHV6nWB…` is the
    // reference hash — a mid-tone image — so a generous band is enough to tell a decoded
    // placeholder from an empty one without pinning the codec's exact output.
    const [red, green, blue, alpha] = painted.centre;
    expect(alpha).toBe(255);
    expect(Math.max(red, green, blue)).toBeGreaterThan(20);
    expect(Math.min(red, green, blue)).toBeLessThan(235);

    // Every rejection path, each of which must leave the box exactly as it was.
    //
    // What this proves is the OUTCOME, not which guard produced it. The length is bounded
    // twice — the projection caps what it stores, the decoder caps what it decodes, both at
    // 200 — so lifting either one alone changes nothing visible here, and the unit tests are
    // what attribute the rejection to a layer. The alphabet check is the one that is
    // uniquely load-bearing at this level: remove it and this test goes red, because the
    // library's own validator waves a non-base83 hash straight through to `decode`.
    expect(await backgroundOf(page, without)).toBe('none');
    expect(await backgroundOf(page, malformed)).toBe('none');
    expect(await backgroundOf(page, overlong)).toBe('none');

    // The placeholder is a background, so the real image still draws over it — a decoded
    // hash must not leave the picture hidden behind a blur.
    await expect(page.locator(`img[alt="${withHash}"]`)).toBeVisible();
  });
});
