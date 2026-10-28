import { InjectionToken, inject } from '@angular/core';
import type { MediaEngine } from './media-engine';
import { JsSdkMediaEngine } from './js-sdk/js-sdk-media-engine';

export const MEDIA_ENGINE = new InjectionToken<MediaEngine>('MEDIA_ENGINE', {
  providedIn: 'root',
  factory: () => inject(JsSdkMediaEngine),
});
