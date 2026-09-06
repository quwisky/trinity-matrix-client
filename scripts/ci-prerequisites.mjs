import { join } from 'node:path';
import { isDirectRun, resultExitCode, runCommand } from './ci-run-command.mjs';

const ROOT = join(import.meta.dirname, '..');
const LOG_DIR = join(ROOT, 'dist', '.ci');

export { runCommand };

export async function runPrerequisites({
  root = ROOT,
  logDir = LOG_DIR,
  timeoutMs,
  run = runCommand,
  abortSignal,
} = {}) {
  const commands = [
    {
      label: 'playwright-install',
      command: 'pnpm',
      args: [
        'exec',
        'playwright',
        'install',
        '--with-deps',
        'chromium',
        'webkit',
      ],
      mandatory: true,
    },
    {
      label: 'docker-pull',
      command: 'docker',
      args: ['compose', '-f', 'e2e/synapse/docker-compose.yml', 'pull', '-q'],
      mandatory: false,
    },
    {
      label: 'development-build',
      command: 'pnpm',
      args: ['exec', 'nx', 'run', 'trinity:build:development'],
      mandatory: true,
    },
  ];
  const results = await Promise.all(
    commands.map((spec) =>
      run({ ...spec, cwd: root, logDir, timeoutMs, abortSignal }),
    ),
  );
  const [playwright, docker, build] = results;
  const dockerWarning =
    resultExitCode(docker) === 0
      ? null
      : `docker pre-pull failed (rc=${resultExitCode(docker)}); global setup will pull`;
  if (dockerWarning) console.warn(`::warning::${dockerWarning}`);
  const mandatory = [playwright, build].find(
    (result) => resultExitCode(result) !== 0,
  );
  return {
    playwright,
    docker: { ...docker, warning: dockerWarning },
    build,
    exitCode: mandatory ? resultExitCode(mandatory) : 0,
  };
}

async function main() {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const result = await runPrerequisites({ abortSignal: controller.signal });
  for (const child of [result.playwright, result.docker, result.build]) {
    console.log(
      `[${child.label}] exit=${resultExitCode(child)} log=${child.logFile}`,
    );
  }
  process.exitCode = controller.signal.aborted ? 143 : result.exitCode;
}

if (isDirectRun(import.meta.url, process.argv)) await main();
