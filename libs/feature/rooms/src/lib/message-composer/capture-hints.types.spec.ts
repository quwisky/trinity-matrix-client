import { describe, expectTypeOf, it } from 'vitest';
import type { MediaHints } from '@trinity/data-access/media';
import type { CaptureHints } from '@trinity/platform-native';

/**
 * The host layer cannot import `MediaHints`, so `CaptureHints` mirrors it and the composer
 * passes one where the other is expected. Assignability alone would let a field added only
 * to `CaptureHints` be dropped on upload; this fails when the two drift in either direction.
 */
describe('capture hints', () => {
  it('stay the same type as the upload hints', () => {
    expectTypeOf<CaptureHints>().toEqualTypeOf<MediaHints>();
  });
});
