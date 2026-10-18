import { describe, expect, it } from 'vitest';
import { isPartOfServer } from './part-of-server';

describe('isPartOfServer', () => {
  it('accepts the server host itself and its subdomains', () => {
    expect(isPartOfServer('https://matrix.org/', 'matrix.org')).toBe(true);
    expect(isPartOfServer('https://account.matrix.org/', 'matrix.org')).toBe(
      true,
    );
    expect(
      isPartOfServer('https://provider.oidc.example/authorize', 'oidc.example'),
    ).toBe(true);
  });

  it('refuses a sibling under a shared parent', () => {
    expect(isPartOfServer('https://auth.ems.host/', 'evil.ems.host')).toBe(
      false,
    );
  });

  it('refuses siblings under a public suffix', () => {
    expect(isPartOfServer('https://auth.example.co.uk/', 'other.co.uk')).toBe(
      false,
    );
    expect(isPartOfServer('https://someone.github.io/', 'hs.github.io')).toBe(
      false,
    );
  });

  it('refuses a host that only ends with the server name', () => {
    expect(isPartOfServer('https://evilmatrix.org/', 'matrix.org')).toBe(false);
  });

  it('compares internationalised names in their punycode form', () => {
    expect(
      isPartOfServer('https://auth.xn--bcher-kva.example/', 'bücher.example'),
    ).toBe(true);
    expect(
      isPartOfServer('https://auth.bücher.example/', 'xn--bcher-kva.example'),
    ).toBe(true);
  });

  it('ignores a trailing dot, letter case and ports', () => {
    expect(isPartOfServer('https://Account.Matrix.ORG./', 'matrix.org.')).toBe(
      true,
    );
    expect(isPartOfServer('https://localhost:8451/', 'localhost:8450')).toBe(
      true,
    );
    expect(isPartOfServer('https://hs.example:8448/', 'HS.example')).toBe(true);
  });

  it('refuses a value that is not a URL', () => {
    expect(isPartOfServer('not a url', 'matrix.org')).toBe(false);
    expect(isPartOfServer('https://matrix.org/', '')).toBe(false);
  });
});
