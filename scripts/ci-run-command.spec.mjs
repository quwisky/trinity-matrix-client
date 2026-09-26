import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  it('never prints or retains a Matrix identifier split across output chunks', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'trinity-ci-run-command-'));
    const eventId = `$${'aB3_-'.repeat(8)}xyz`;
    const printed = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        printed.push(String(chunk));
        return true;
      });
    try {
      const result = await runCommand({
        command: process.execPath,
        args: [
          '--input-type=module',
          '-e',
          `const id = ${JSON.stringify(eventId)};
           process.stdout.write('Event ' + id.slice(0, 12));
           await new Promise((resolve) => setTimeout(resolve, 50));
           process.stdout.write(id.slice(12) + ' already in timeline\\n');
           process.stderr.write('room !AbCdEfGhIjKlMnOpQr:localhost');`,
        ],
        label: 'identifiers',
        logDir,
      });
      write.mockRestore();
      expect(result.exitCode).toBe(0);
      const log = readFileSync(result.logFile, 'utf8');
      for (const text of [printed.join(''), log]) {
        expect(text).not.toContain(eventId.slice(1));
        expect(text).not.toContain('AbCdEfGhIjKlMnOpQr');
      }
      expect(log).toContain('Event [REDACTED] already in timeline');
      expect(log).toContain('room [REDACTED]');
    } finally {
      write.mockRestore();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
