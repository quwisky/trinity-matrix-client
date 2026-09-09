import { join } from 'node:path';
import { isDirectRun, resultExitCode, runCommand } from './ci-run-command.mjs';

const ROOT = join(import.meta.dirname, '..');
export { runCommand };

/** Wait for every selected prerequisite; an optional image pre-pull cannot mask a build failure. */
export async function runPrerequisites({
  root = ROOT,
  logDir = join(root, 'dist/.ci'),
  timeoutMs,
  run = runCommand,
  abortSignal,
  browsers = ['chromium', 'webkit'],
  includeDocker = true,
  buildTarget = 'trinity:build:development',
} = {}) {
  if (
    !Array.isArray(browsers) ||
    browsers.length === 0 ||
    browsers.some(
      (browser) => !['chromium', 'firefox', 'webkit'].includes(browser),
    )
  )
    throw new Error(
      'browsers must be a non-empty list from chromium, firefox, webkit',
    );
  if (
    buildTarget !== null &&
    !/^[a-z0-9-]+:[a-z0-9-]+(?::[a-z0-9-]+)?$/.test(buildTarget)
  ) {
    throw new Error('buildTarget must be a registered Nx target or null');
  }
  const commands = [
    {
      label: 'playwright-install',
      command: 'pnpm',
      args: ['exec', 'playwright', 'install', '--with-deps', ...browsers],
      mandatory: true,
    },
  ];
  if (includeDocker)
    commands.push({
      label: 'docker-pull',
      command: 'docker',
      args: [
        'compose',
        '-f',
        'e2e/support/synapse/docker-compose.yml',
        'pull',
        '-q',
      ],
      mandatory: false,
    });
  if (buildTarget)
    commands.push({
      label: 'development-build',
      command: 'pnpm',
      args: ['exec', 'nx', 'run', buildTarget],
      mandatory: true,
    });
  const settled = await Promise.allSettled(
    commands.map(async (spec) =>
      run({ ...spec, cwd: root, logDir, timeoutMs, abortSignal }),
    ),
  );
  const results = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const spec = commands[index];
    console.error(
      `[${spec.label}] prerequisite could not run: ${String(result.reason)}`,
    );
    return { ...spec, exitCode: 1, error: result.reason };
  });
  const playwright = results.find(
    ({ label }) => label === 'playwright-install',
  );
  const docker = results.find(({ label }) => label === 'docker-pull');
  const build = results.find(({ label }) => label === 'development-build');
  const dockerWarning =
    docker && resultExitCode(docker) !== 0
      ? `docker pre-pull failed (rc=${resultExitCode(docker)}); global setup will pull`
      : null;
  if (dockerWarning) console.warn(`::warning::${dockerWarning}`);
  const mandatoryFailure = results.find(
    (result, index) =>
      commands[index].mandatory && resultExitCode(result) !== 0,
  );
  return {
    playwright,
    docker: docker ? { ...docker, warning: dockerWarning } : undefined,
    build,
    exitCode: mandatoryFailure ? resultExitCode(mandatoryFailure) : 0,
  };
}

async function main() {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const result = await runPrerequisites({ abortSignal: controller.signal });
  for (const child of [result.playwright, result.docker, result.build].filter(
    Boolean,
  )) {
    console.log(
      `[${child.label}] exit=${resultExitCode(child)} log=${child.logFile}`,
    );
  }
  process.exitCode = controller.signal.aborted ? 143 : result.exitCode;
}

if (isDirectRun(import.meta.url)) await main();
