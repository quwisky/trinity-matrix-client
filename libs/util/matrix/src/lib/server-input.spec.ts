import { describe, expect, it } from 'vitest';
import { serverNameOfInput } from './server-input';

describe('serverNameOfInput', () => {
  it.each([
    ['example.org', 'example.org'],
    [' example.org ', 'example.org'],
    ['example.org:8448', 'example.org:8448'],
    ['@alice:example.org', 'example.org'],
    ['alice:example.org', 'example.org'],
    ['@alice:example.org:8448', 'example.org:8448'],
    ['[::1]:8448', '[::1]:8448'],
    ['[::1]', '[::1]'],
    ['https://example.org:8448', 'example.org:8448'],
    ['https://example.org/', 'example.org'],
    ['HTTPS://Example.org:443/path', 'example.org'],
    ['user:pass@example.org', 'example.org'],
    ['example.org:8448/', 'example.org:8448'],
  ])('reads %j as %j', (input, expected) => {
    expect(serverNameOfInput(input)).toBe(expected);
  });
});
