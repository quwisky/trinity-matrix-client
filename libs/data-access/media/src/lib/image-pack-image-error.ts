export type ImagePackImageErrorCode = 'unsupported-type' | 'animated-too-large';

export class ImagePackImageError extends Error {
  constructor(readonly code: ImagePackImageErrorCode) {
    super(code);
    this.name = 'ImagePackImageError';
  }
}
