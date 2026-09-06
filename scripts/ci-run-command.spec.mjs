import { describe, expect, it } from 'vitest';
import { runCommand } from './ci-run-command.mjs';

describe('ci-run-command', () => {
  it('returns a failed outcome before the command can outlive the timeout', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['--input-type=module', '-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 100,
      label: 'suite',
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
