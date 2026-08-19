import { decode, isBlurhashValid } from 'blurhash';

/**
 * Turn an MSC2448 blurhash into a data URL to paint while the real image loads.
 *
 * A blurhash is a ~30-character string encoding a handful of DCT coefficients — the shape
 * and colours of a picture with none of its detail. Decoding one costs microseconds, so a
 * recipient can show something that looks like the incoming photo immediately rather than
 * an empty box, and the swap to the real bytes is a change of texture rather than of
 * layout.
 *
 * ## Why a data URL rather than a `<canvas>` in the template
 *
 * The placeholder has to sit behind the image and disappear underneath it. As a background
 * image that is one CSS declaration on the box that already reserves the space; as a canvas
 * element it is a second element to position, size, and tear down, plus a `viewChild` and
 * an effect to paint it after the view initialises. The canvas is still what does the
 * decoding here — it is just detached, used once, and left to the garbage collector.
 *
 * ## Sizing
 *
 * A blurhash is defined over a UNIT square: its coefficients carry no aspect ratio. So the
 * decode size is arbitrary and the result is stretched to whatever box it lands in — a 16:9
 * photo decoded at 32×32 and stretched back to 16:9 is exactly right, not distorted. 32 is
 * far more than the 9×9 maximum component count can express and keeps the data URL short
 * enough to sit in a style attribute without bloating the DOM.
 */
const DECODE_SIZE = 32;

/**
 * Cap on the hash we will hand to the decoder.
 *
 * This is attacker-controlled federated input: the sender picks the string. `decode` is
 * O(pixels × components) and a hostile string can claim the maximum 9×9 components, so the
 * length is bounded before the decoder ever sees it — the same treatment the received voice
 * waveform gets in `message-view.ts`. A legal 9×9 hash is 1 + 1 + 4 + 2 × 80 = 166 chars;
 * 200 leaves room for a spec that grows without admitting anything unbounded.
 *
 * `isBlurhashValid` then checks the structure — that the declared component count matches
 * the string's actual length, and that every character is in the base83 alphabet — so a
 * malformed hash is ignored rather than throwing out of a getter.
 */
export const MAX_BLURHASH_LENGTH = 200;

/**
 * The base83 alphabet a blurhash is written in.
 *
 * Checked here because the library's own `isBlurhashValid` does NOT: it compares the string's
 * length against the component count its first character declares, and stops. A hash carrying
 * a character outside this set — `!`, a space, anything a mangled or hostile sender produces —
 * passes that check, and `decode` then resolves the unknown character to an index of -1 and
 * paints a smear of the wrong colours. No crash and no unbounded work, but a placeholder that
 * misrepresents the image is worse than none, so malformed input is refused rather than drawn.
 */
const BASE83 = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]+$/;

/**
 * Decode `hash` into a `data:image/png` URL, or null if it is unusable.
 *
 * Returns null rather than throwing: a bad hash is a cosmetic disappointment, not an error
 * worth failing a message render over. The caller falls back to its ordinary skeleton.
 */
export function blurhashToDataUrl(hash: string | undefined): string | null {
  if (
    !hash ||
    hash.length > MAX_BLURHASH_LENGTH ||
    !BASE83.test(hash) ||
    !isBlurhashValid(hash).result
  ) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = DECODE_SIZE;
  canvas.height = DECODE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const pixels = decode(hash, DECODE_SIZE, DECODE_SIZE);
  const image = context.createImageData(DECODE_SIZE, DECODE_SIZE);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
