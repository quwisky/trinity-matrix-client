import { join } from 'node:path';
import { resultExitCode, runCommand } from './ci-run-command.mjs';
import { resolveHomeserverKind } from '../e2e/support/homeserver/kind.mts';

const ROOT = join(import.meta.dirname, '..');
const LOG_DIR = join(ROOT, 'dist', '.ci');

export { runCommand };

// A stalled mirror can hang apt for tens of minutes: bound each install attempt and retry once.
const INSTALL_ATTEMPT_MS = 6 * 60 * 1000;

export async function runPrerequisites({
  root = ROOT,
  logDir = LOG_DIR,
  timeoutMs,
  run = runCommand,
  abortSignal,
  env = process.env,
} = {}) {
  // The images of the homeserver this job will actually start (TRINITY_E2E_HOMESERVER).
  const homeserver = 'e2e/support/homeserver';
  const kind = resolveHomeserverKind(env);
  // Space-separated; jobs that drive one browser skip the other's host libraries.
  const browsers = (env.TRINITY_PLAYWRIGHT_BROWSERS ?? 'chromium webkit')
    .split(/\s+/)
    .filter(Boolean);
  const commands = [
    {
      label: 'playwright-install',
      command: 'pnpm',
      args: ['exec', 'playwright', 'install', '--with-deps', ...browsers],
      mandatory: true,
    },
    {
      label: 'docker-pull',
      command: 'docker',
      args: [
        'compose',
        '-f',
        `${homeserver}/docker-compose.yml`,
        '-f',
        `${homeserver}/${kind}/docker-compose.yml`,
        'pull',
        '-q',
      ],
      mandatory: false,
    },
    {
      label: 'development-build',
      command: 'pnpm',
      args: ['exec', 'nx', 'run', 'trinity:build:development'],
      mandatory: true,
    },
  ];
  const start = (spec, limit = timeoutMs) =>
    run({ ...spec, cwd: root, logDir, timeoutMs: limit, abortSignal });
  const installWithRetry = async (spec) => {
    const first = await start(spec, INSTALL_ATTEMPT_MS);
    const rc = resultExitCode(first);
    if (rc === 0 || first.aborted) return first;
    console.warn(
      `::warning::playwright install attempt 1 failed (rc=${rc}); retrying`,
    );
    return start(spec, INSTALL_ATTEMPT_MS);
  };
  const results = await Promise.all(
    commands.map((spec) =>
      spec.label === 'playwright-install'
        ? installWithRetry(spec)
        : start(spec),
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

if (import.meta.main) await main();
