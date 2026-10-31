import { describe, expect, it } from 'vitest';
import {
  LIBS,
  RUST_LIBS,
  buildContractCommand,
  contractEngine,
} from './run.mts';

describe('buildContractCommand', () => {
  it('runs only the Rust libraries, filtered on .rust.spec, as engine.rust', () => {
    const command = buildContractCommand('rust', 'run-1');

    expect(command.suiteId).toBe('engine.rust');
    expect(command.summaryFile).toContain('/run-1/engine.rust/');
    expect(command.runs.map(({ project }) => project)).toEqual([
      'data-access-homeserver',
      'data-access-discovery',
      'data-access-matrix-client',
      'data-access-identity',
      'data-access-contact-addresses',
    ]);
    // A Rust contract is the js-sdk contract run on another engine.
    expect(LIBS).toEqual(expect.arrayContaining([...RUST_LIBS]));
    for (const { args } of command.runs) {
      // "trust" contains "rust": a bare `rust` filter would run data-access-trust specs.
      expect(args).toContain('.rust.spec');
      expect(args).not.toContain('rust');
      expect(args).not.toContain('synapse');
    }
  });

  it('runs every js-sdk library, filtered on synapse, as engine.js-sdk', () => {
    const command = buildContractCommand('js-sdk', 'run-1');

    expect(command.suiteId).toBe('engine.js-sdk');
    expect(command.runs.map(({ project }) => project)).toEqual([...LIBS]);
    for (const { project, args, reportFile } of command.runs) {
      expect(args.slice(0, 6)).toEqual([
        'exec',
        'nx',
        'run',
        `${project}:test`,
        '--skip-nx-cache',
        '--',
      ]);
      expect(args[6]).toBe('synapse');
      expect(args).toContain(`--outputFile.json=${reportFile}`);
    }
  });
});

describe('contractEngine', () => {
  it('reads --engine and ignores the args `pnpm e2e:protocol -- <args>` forwards', () => {
    expect(contractEngine([])).toBe('js-sdk');
    expect(contractEngine(['--engine', 'rust'])).toBe('rust');
    expect(contractEngine(['--grep', 'probe', 'extra'])).toBe('js-sdk');
    expect(() => contractEngine(['--engine', 'wasm'])).toThrow(
      '--engine must be js-sdk or rust, not wasm',
    );
  });
});
