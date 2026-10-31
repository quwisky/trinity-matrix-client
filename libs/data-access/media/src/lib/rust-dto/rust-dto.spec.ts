import { describe, expectTypeOf, it } from 'vitest';
import type { DeepWritable } from '@trinity/util/matrix';
import type {
  MediaContent,
  MediaRequest,
  UploadedContent,
  UploadRequest,
} from '../media-engine';
import type { MediaContentDto } from './MediaContentDto';
import type { MediaRequestDto } from './MediaRequestDto';
import type { UploadedContentDto } from './UploadedContentDto';
import type { UploadRequestDto } from './UploadRequestDto';

describe('Rust engine DTOs', () => {
  it('match what the TypeScript types describe, numbers included', () => {
    expectTypeOf<MediaContentDto>().toEqualTypeOf<DeepWritable<MediaContent>>();
    expectTypeOf<MediaRequest>().toExtend<DeepWritable<MediaRequestDto>>();
    expectTypeOf<UploadedContentDto>().toEqualTypeOf<
      DeepWritable<UploadedContent>
    >();
    expectTypeOf<UploadRequest>().toExtend<DeepWritable<UploadRequestDto>>();
  });
});
