import { describe, expect, it } from 'vitest';
import {
  WIDGET_NAME_MAX_CODE_POINTS,
  WIDGET_URL_MAX_BYTES,
  validateRoomWidgetDraft,
} from './widget-management-policy';

describe('validateRoomWidgetDraft', () => {
  it('trims a valid HTTPS declaration while preserving its template', () => {
    expect(
      validateRoomWidgetDraft({
        name: '  Planning board  ',
        rawUrl: '  https://widgets.example/room/$matrix_room_id  ',
      }),
    ).toEqual({
      value: {
        name: 'Planning board',
        rawUrl: 'https://widgets.example/room/$matrix_room_id',
        origin: 'https://widgets.example',
      },
      failure: null,
    });
  });

  it.each([
    [{ name: '', rawUrl: 'https://widgets.example' }, 'name-required'],
    [
      {
        name: 'x'.repeat(WIDGET_NAME_MAX_CODE_POINTS + 1),
        rawUrl: 'https://widgets.example',
      },
      'name-too-long',
    ],
    [{ name: 'Board', rawUrl: '' }, 'url-required'],
    [{ name: 'Board', rawUrl: 'not a URL' }, 'invalid-url'],
    [{ name: 'Board', rawUrl: 'http://widgets.example' }, 'https-required'],
    [
      { name: 'Board', rawUrl: 'https://user:secret@widgets.example' },
      'credentials',
    ],
    [
      { name: 'Board', rawUrl: 'https://$matrix_user_id.example/widget' },
      'dynamic-origin',
    ],
  ] as const)('rejects %o as %s', (draft, failure) => {
    expect(validateRoomWidgetDraft(draft)).toEqual({ value: null, failure });
  });

  it('counts names by Unicode code point and URLs by encoded byte', () => {
    expect(
      validateRoomWidgetDraft({
        name: '🚀'.repeat(WIDGET_NAME_MAX_CODE_POINTS),
        rawUrl: 'https://widgets.example',
      }).failure,
    ).toBeNull();

    const prefix = 'https://widgets.example/';
    const rawUrl = `${prefix}${'é'.repeat(
      Math.floor((WIDGET_URL_MAX_BYTES - prefix.length) / 2) + 1,
    )}`;
    expect(validateRoomWidgetDraft({ name: 'Board', rawUrl }).failure).toBe(
      'url-too-long',
    );
  });
});
