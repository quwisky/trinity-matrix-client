import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_PIXEL_RATIO,
  displayThumbnailEdge,
  UPLOAD_THUMBNAIL_PX,
} from './thumbnail-size';

describe('displayThumbnailEdge', () => {
  it.each([
    [1, 320],
    [1.25, 640],
    [1.5, 640],
    [2, 640],
    [2.5, 960],
    [3, 960],
  ])('sizes a %sx screen to the %i px bucket', (dpr, edge) => {
    expect(displayThumbnailEdge(dpr)).toBe(edge);
  });

  it('clamps a ratio above 3x to the 960 px bucket', () => {
    expect(displayThumbnailEdge(4)).toBe(960);
  });

  it('rounds a sub-1x ratio up to the 320 px bucket', () => {
    expect(displayThumbnailEdge(0.75)).toBe(320);
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats an unusable ratio %s as 1x',
    (dpr) => {
      expect(displayThumbnailEdge(dpr)).toBe(320);
    },
  );
});

describe('UPLOAD_THUMBNAIL_PX', () => {
  it('is the fixed, sender-independent 2 × 320 px edge', () => {
    expect(UPLOAD_THUMBNAIL_PX).toBe(640);
  });
});

describe('DEVICE_PIXEL_RATIO', () => {
  it('reads the window ratio each time it is called', () => {
    const view = { devicePixelRatio: 2 };
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: view } }],
    });
    const read = TestBed.inject(DEVICE_PIXEL_RATIO);

    expect(read()).toBe(2);
    view.devicePixelRatio = 3;
    expect(read()).toBe(3);
  });

  it('falls back to 1 without a window', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: null } }],
    });

    expect(TestBed.inject(DEVICE_PIXEL_RATIO)()).toBe(1);
  });
});
