import { describe, expect, it } from 'vitest';
import { scrub } from '../e2e/mobile/support/scrub.mts';

describe('mobile E2E artifact scrub', () => {
  it('removes Matrix ids, tokens and passwords', () => {
    const out = scrub(
      '@alice:localhost !abc:localhost $AbCdEfGhIjKlMnOpQrStUv syt_x_y {"password":"p"}',
    );
    expect(out).toBe(
      '@<user> !<room> $<event> <token> {"password":"<redacted>"}',
    );
  });

  it('redacts text typed into a form field', () => {
    expect(scrub('body: {"text":"smoke-pass-123"}')).toBe(
      'body: {"text":"<typed>"}',
    );
    expect(scrub('{"value":["p","a","s","s"]}')).toBe('{"value":["<typed>"]}');
  });
});
