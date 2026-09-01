import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  protocolResponseFailure,
  redactProtocolDiagnostic,
} from './diagnostics.mts';
import { runProtocol } from './run.mts';
import {
  PROTOCOL_CASES,
  PROTOCOL_MODE_ENV,
  PROTOCOL_SUITE_ENV,
  protocolMode,
  protocolResources,
  protocolScreenshotPolicy,
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
    expect(protocolScreenshotPolicy('remote')).toBe('off');
    expect(protocolScreenshotPolicy('disposable')).toBe('only-on-failure');
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

  it('keeps non-mutating protocol cases on the credential-free fixture', () => {
    const definitions = Object.values(PROTOCOL_CASES);
    expect(definitions.length).toBeGreaterThan(0);

    for (const definition of definitions) {
      const source = readFileSync(
        join(import.meta.dirname, definition.spec),
        'utf8',
      )
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/[^\n]*/gu, '');
      const standaloneImport =
        "import { standaloneTest as test, expect } from './fixtures.mts';";

      if (definition.remoteMutation) {
        expect(source, definition.spec).not.toContain(standaloneImport);
      } else {
        expect(source, definition.spec).toContain(standaloneImport);
      }
    }
  });

  it('redacts raw and encoded supplied secrets and omits remote bodies', () => {
    const credentials = remoteProtocolCredentials(
      'protocol.rooms',
      remoteEnvironment(),
    );
    const diagnostic = redactProtocolDiagnostic(
      `raw=primary-secret encoded=${encodeURIComponent('secondary-secret')}`,
      credentials,
    );
    expect(diagnostic).not.toContain('primary-secret');
    expect(diagnostic).not.toContain('secondary-secret');
    expect(diagnostic).toContain('[REDACTED]');
    const statusTextSentinel = 'server-controlled-bearer-token';
    const serverControlledResponse = {
      status: 401,
      statusText: statusTextSentinel,
    };
    const responseFailure = protocolResponseFailure(
      'POST /login',
      serverControlledResponse,
    );
    expect(responseFailure.message).toBe('POST /login → 401');
    expect(responseFailure.message).not.toContain(statusTextSentinel);
  });

  it('maps one focused invocation into the shared runner with its environment', async () => {
    const execute = vi.fn(async () => 0);
    const environment: NodeJS.ProcessEnv = {};

    await expect(
      runProtocol(
        ['--suite=protocol.verify-sas', '--headed', '--grep=SAS'],
        environment,
        execute,
      ),
    ).resolves.toBe(0);

    expect(environment).toMatchObject({
      [PROTOCOL_SUITE_ENV]: 'protocol.verify-sas',
      [PROTOCOL_MODE_ENV]: 'disposable',
    });
    expect(execute).toHaveBeenCalledWith(
      [
        '--config=e2e/protocol/playwright.config.mts',
        '--build=trinity:build:development',
        '--resource=synapse',
        '--',
        '--headed',
        '--grep=SAS',
      ],
      environment,
    );
  });

  it('rejects missing and unknown suite arguments without starting Playwright', async () => {
    const execute = vi.fn(async () => 0);
    await expect(runProtocol([], {}, execute)).rejects.toThrow(
      '--suite=<registered-suite-id>',
    );
    await expect(
      runProtocol(['--suite=protocol.unknown'], {}, execute),
    ).rejects.toThrow('--suite=<registered-suite-id>');
    expect(execute).not.toHaveBeenCalled();
  });
});
