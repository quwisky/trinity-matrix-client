import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_CASES,
  PROTOCOL_MODE_ENV,
  protocolMode,
  protocolResources,
  protocolTracePolicy,
  remoteProtocolCredentials,
} from './runtime.mts';

const remoteEnvironment = (): NodeJS.ProcessEnv => ({
  [PROTOCOL_MODE_ENV]: 'remote',
  TRINITY_HS: 'https://matrix.example.test',
  TRINITY_USER: 'protocol-primary',
  TRINITY_PASS: 'primary-secret',
  TRINITY_SECONDARY_USER: 'protocol-secondary',
  TRINITY_SECONDARY_PASS: 'secondary-secret',
});

describe('protocol runtime configuration', () => {
  it('defaults to disposable mode and rejects unknown modes', () => {
    expect(protocolMode({})).toBe('disposable');
    expect(() => protocolMode({ [PROTOCOL_MODE_ENV]: 'implicit' })).toThrow(
      `${PROTOCOL_MODE_ENV} must be either disposable or remote`,
    );
  });

  it('requires explicit complete credentials for remote mutation', () => {
    expect(() =>
      remoteProtocolCredentials('protocol.verify-sas', {
        [PROTOCOL_MODE_ENV]: 'remote',
      }),
    ).toThrow('Remote protocol mode requires TRINITY_HS');
    expect(() =>
      remoteProtocolCredentials('protocol.verify-sas', {
        ...remoteEnvironment(),
        TRINITY_PASS: undefined,
      }),
    ).toThrow('Remote protocol mode requires TRINITY_PASS');
  });

  it('requires secure credential-free homeserver URLs', () => {
    expect(() =>
      remoteProtocolCredentials('protocol.verify-sas', {
        ...remoteEnvironment(),
        TRINITY_HS: 'http://matrix.example.test',
      }),
    ).toThrow('TRINITY_HS must be an absolute HTTPS URL');
    expect(() =>
      remoteProtocolCredentials('protocol.verify-sas', {
        ...remoteEnvironment(),
        TRINITY_HS: 'https://user:secret@matrix.example.test',
      }),
    ).toThrow('without embedded credentials');
    expect(() =>
      remoteProtocolCredentials('protocol.verify-sas', {
        ...remoteEnvironment(),
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      }),
    ).toThrow('requires TLS certificate verification');
  });

  it('requires a supplied second test account only where the flow needs one', () => {
    const credentials = remoteProtocolCredentials(
      'protocol.rooms',
      remoteEnvironment(),
    );
    expect(credentials.secondary).toEqual({
      user: 'protocol-secondary',
      pass: 'secondary-secret',
    });
    expect(
      remoteProtocolCredentials('protocol.verify-sas', remoteEnvironment())
        .secondary,
    ).toBeUndefined();
  });

  it('does not expose supplied secrets in validation failures', () => {
    const environment = {
      ...remoteEnvironment(),
      TRINITY_SECONDARY_USER: undefined,
    };
    let message = '';
    try {
      remoteProtocolCredentials('protocol.rooms', environment);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('primary-secret');
    expect(message).not.toContain('secondary-secret');
    expect(message).toContain('TRINITY_SECONDARY_USER');
  });

  it('never persists traces for authenticated remote runs', () => {
    expect(protocolTracePolicy('remote', false)).toBe('off');
    expect(protocolTracePolicy('remote', true)).toBe('off');
    expect(protocolTracePolicy('disposable', false)).toBe('retain-on-failure');
    expect(protocolTracePolicy('disposable', true)).toBe('on-first-retry');
  });

  it('drops only the local Synapse lease in explicit remote mode', () => {
    expect(protocolResources('protocol.verify-sas', 'disposable')).toEqual([
      'synapse',
    ]);
    expect(
      protocolResources('protocol.verify-sas', 'remote', remoteEnvironment()),
    ).toEqual([]);
    expect(
      protocolResources('protocol.crypto-spike-chromium', 'disposable'),
    ).toEqual(['crypto-spike']);
  });

  it('does not allow non-mutating network checks to enter remote mutation mode', () => {
    expect(() =>
      remoteProtocolCredentials('protocol.login-smoke', remoteEnvironment()),
    ).toThrow('protocol.login-smoke does not support remote mutation mode');
  });

  it('declares one executable case for every protocol suite', () => {
    expect(Object.keys(PROTOCOL_CASES)).toHaveLength(13);
    expect(
      new Set(Object.values(PROTOCOL_CASES).map(({ spec }) => spec)).size,
    ).toBe(12);
  });
});
