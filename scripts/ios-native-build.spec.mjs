import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNative, validateDiagnostics } from './ios-native-build.mjs';

const workspaceRoot = resolve(process.cwd(), '..');
const fixtureRoots = [];
const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
}).trim();

function fixtureEnvironment(mode = 'success') {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'trinity-ios-native-'));
  fixtureRoots.push(fixtureRoot);
  const bin = join(fixtureRoot, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'xcodebuild');
  writeFileSync(
    fake,
    `#!/bin/sh
set -eu
if [ "${mode}" = "toolchain-failure" ] && [ "$1" = "-version" ]; then echo 'xcodebuild unavailable' >&2; exit 66; fi
if [ "$1" = "-version" ]; then echo 'Xcode 26.0'; exit 0; fi
if [ "${mode}" = "settings-failure" ] && printf '%s\\n' "$@" | grep -q -- '-showBuildSettings'; then echo 'settings unavailable' >&2; exit 67; fi
if printf '%s\\n' "$@" | grep -q -- '-showBuildSettings'; then
  printf '%s\\n' '[{"buildSettings":{"SDKROOT":"iphonesimulator","CONFIGURATION":"Debug","CODE_SIGNING_ALLOWED":"NO"}}]'
  exit 0
fi
result=''
previous=''
for arg in "$@"; do
  if [ "$previous" = '-resultBundlePath' ]; then result="$arg"; fi
  previous="$arg"
done
if [ "${mode}" = "timeout" ]; then sleep 5; fi
if [ "${mode}" = "cancel" ] || [ "${mode}" = "outer-timeout" ]; then
  echo $$ > "$IOS_FIXTURE_ROOT/compiler.pid"
  (sleep 60) &
  echo $! > "$IOS_FIXTURE_ROOT/descendant.pid"
  echo 'compiler-ready'
  trap 'exit 143' INT TERM
  while :; do sleep 1; done
fi
if [ -n "$result" ]; then mkdir -p "$result"; echo result > "$result/Info.plist"; fi
if [ "${mode}" = "failure" ]; then echo 'swiftc error' >&2; exit 65; fi
echo 'compile output'
`,
  );
  chmodSync(fake, 0o755);
  const xcrun = join(bin, 'xcrun');
  writeFileSync(xcrun, '#!/bin/sh\necho 26.0\n');
  chmodSync(xcrun, 0o755);
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CI_IOS_SHA: checkoutSha,
    IOS_FIXTURE_ROOT: fixtureRoot,
    IOS_FIXTURE_MODE: mode,
  };
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return;
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for process exit')),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function processIsAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (
    existsSync(path) &&
    processIsAlive(readFileSync(path, 'utf8').trim())
  ) {
    if (Date.now() >= deadline)
      throw new Error(`process in ${path} remained alive`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function terminateGroup(child, signal = 'SIGTERM') {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function runHelper(environment, args = ['build']) {
  const outputPath = join(environment.IOS_FIXTURE_ROOT, 'github-output');
  environment.GITHUB_OUTPUT = outputPath;
  const child = spawn(
    process.execPath,
    ['scripts/ios-native-build.mjs', ...args],
    {
      cwd: workspaceRoot,
      env: environment,
      detached: true,
      stdio: 'ignore',
    },
  );
  try {
    await waitForFile(join(environment.IOS_FIXTURE_ROOT, 'compiler.pid'));
    await waitForFile(outputPath);
    const diagnosticRoot = readFileSync(outputPath, 'utf8').match(
      /^diagnostic-root=(.+)$/m,
    )?.[1];
    if (!diagnosticRoot) throw new Error('helper did not emit diagnostic root');
    return { child, diagnosticRoot };
  } catch (error) {
    terminateGroup(child);
    await waitForExit(child).catch(() => undefined);
    throw error;
  }
}

async function runOuterTimeout(environment) {
  const outputPath = join(environment.IOS_FIXTURE_ROOT, 'github-output');
  environment.GITHUB_OUTPUT = outputPath;
  const child = spawn(
    process.execPath,
    [
      'scripts/ci-run-command.mjs',
      '--timeout-ms',
      '5000',
      '--',
      process.execPath,
      'scripts/ios-native-build.mjs',
      'build',
    ],
    { cwd: workspaceRoot, env: environment, detached: true, stdio: 'ignore' },
  );
  try {
    await waitForFile(join(environment.IOS_FIXTURE_ROOT, 'compiler.pid'));
    await waitForFile(outputPath);
    const diagnosticRoot = readFileSync(outputPath, 'utf8').match(
      /^diagnostic-root=(.+)$/m,
    )?.[1];
    if (!diagnosticRoot)
      throw new Error('outer wrapper did not preserve diagnostic root');
    return { child, diagnosticRoot };
  } catch (error) {
    terminateGroup(child);
    await waitForExit(child).catch(() => undefined);
    throw error;
  }
}

afterEach(() =>
  fixtureRoots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe('iOS native build diagnostics', () => {
  it('runs the real command collector with unsigned settings and unique default roots', async () => {
    const environment = fixtureEnvironment();
    const first = await buildNative({ root: workspaceRoot, environment });
    const second = await buildNative({ root: workspaceRoot, environment });
    fixtureRoots.push(first.diagnosticRoot, second.diagnosticRoot);
    expect(first.execution.compilerStarted).toBe(true);
    expect(first.execution.checkoutSha).toBe(checkoutSha);
    expect(first.execution.args).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(
      first.execution.args.some((arg) =>
        arg.startsWith(
          join(workspaceRoot, 'dist', 'ios-native', 'DerivedData'),
        ),
      ),
    ).toBe(true);
    expect(first.diagnosticRoot).not.toBe(second.diagnosticRoot);
    expect(
      validateDiagnostics(first.diagnosticRoot, { expectedSha: checkoutSha })
        .ok,
    ).toBe(true);
    expect(
      readFileSync(join(first.diagnosticRoot, 'build-settings.json'), 'utf8'),
    ).toContain('SDKROOT');
  });

  it('retains a compiler failure and keeps validation red', async () => {
    const result = await buildNative({
      root: workspaceRoot,
      environment: fixtureEnvironment('failure'),
    });
    fixtureRoots.push(result.diagnosticRoot);
    expect(result.exitCode).toBe(65);
    expect(
      readFileSync(join(result.diagnosticRoot, 'xcodebuild.log'), 'utf8'),
    ).toContain('swiftc error');
    expect(
      validateDiagnostics(result.diagnosticRoot, { expectedSha: checkoutSha })
        .ok,
    ).toBe(false);
  });

  it('records a real subprocess timeout and preserves the diagnostic root', async () => {
    const result = await buildNative({
      root: workspaceRoot,
      environment: fixtureEnvironment('timeout'),
      timeoutMs: 100,
    });
    fixtureRoots.push(result.diagnosticRoot);
    expect(result.execution.compilerStarted).toBe(true);
    expect(result.execution.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(
      validateDiagnostics(result.diagnosticRoot, { expectedSha: checkoutSha })
        .ok,
    ).toBe(false);
  });

  it('rejects each missing, empty, malformed, and symlinked required diagnostic', async () => {
    const base = await buildNative({
      root: workspaceRoot,
      environment: fixtureEnvironment(),
    });
    fixtureRoots.push(base.diagnosticRoot);
    const required = [
      'xcodebuild.log',
      'toolchain.txt',
      'build-settings.json',
      'execution.json',
      'build.xcresult',
    ];
    const diagnosticNames = {
      'xcodebuild.log': 'log',
      'toolchain.txt': 'toolchain',
      'build-settings.json': 'settings',
      'execution.json': 'execution',
      'build.xcresult': 'result',
    };
    for (const name of required) {
      const root = join(
        workspaceRoot,
        'dist',
        'ios-native',
        `run.missing-${name.replaceAll('.', '-')}`,
      );
      cpSync(base.diagnosticRoot, root, { recursive: true });
      fixtureRoots.push(root);
      rmSync(join(root, name), { recursive: true, force: true });
      const result = validateDiagnostics(root, { expectedSha: checkoutSha });
      expect(result.errors).toContain(
        `missing iOS diagnostic: ${diagnosticNames[name]}`,
      );
    }
    for (const name of [
      'xcodebuild.log',
      'toolchain.txt',
      'build-settings.json',
      'execution.json',
    ]) {
      const root = join(
        workspaceRoot,
        'dist',
        'ios-native',
        `run.empty-${name.replaceAll('.', '-')}`,
      );
      cpSync(base.diagnosticRoot, root, { recursive: true });
      fixtureRoots.push(root);
      writeFileSync(join(root, name), '');
      expect(
        validateDiagnostics(root, { expectedSha: checkoutSha }).errors,
      ).toContain(`missing iOS diagnostic: ${diagnosticNames[name]}`);
    }
    for (const [name, content] of [
      ['build-settings.json', '{'],
      ['execution.json', '{'],
    ]) {
      const root = join(
        workspaceRoot,
        'dist',
        'ios-native',
        `run.malformed-${name.replaceAll('.', '-')}`,
      );
      cpSync(base.diagnosticRoot, root, { recursive: true });
      fixtureRoots.push(root);
      writeFileSync(join(root, name), content);
      expect(
        validateDiagnostics(root, { expectedSha: checkoutSha }).errors,
      ).toContain(
        `malformed iOS diagnostic: ${name === 'build-settings.json' ? 'settings' : 'execution'}`,
      );
    }
    for (const name of required) {
      const root = join(
        workspaceRoot,
        'dist',
        'ios-native',
        `run.symlink-${name.replaceAll('.', '-')}`,
      );
      cpSync(base.diagnosticRoot, root, { recursive: true });
      fixtureRoots.push(root);
      const target = join(root, '.evidence-target');
      if (name === 'build.xcresult') {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'result'), 'result');
      } else writeFileSync(target, 'evidence');
      rmSync(join(root, name), { recursive: true, force: true });
      symlinkSync(target, join(root, name));
      expect(
        validateDiagnostics(root, { expectedSha: checkoutSha }).errors,
      ).toContain(`missing iOS diagnostic: ${diagnosticNames[name]}`);
    }
  });

  it('does not start the compiler when toolchain or settings preparation fails', async () => {
    for (const mode of ['toolchain-failure', 'settings-failure']) {
      const environment = fixtureEnvironment(mode);
      const result = await buildNative({ root: workspaceRoot, environment });
      fixtureRoots.push(result.diagnosticRoot);
      expect(result.execution.compilerStarted).toBe(false);
      expect(result.execution.phase).toBe(
        mode === 'toolchain-failure' ? 'toolchain' : 'settings',
      );
      expect(
        existsSync(join(environment.IOS_FIXTURE_ROOT, 'compiler.pid')),
      ).toBe(false);
    }
  });

  it('cancels the actual helper CLI and reaps the compiler descendant', async () => {
    const environment = fixtureEnvironment('cancel');
    const { child, diagnosticRoot } = await runHelper(environment);
    try {
      terminateGroup(child, 'SIGINT');
      await waitForExit(child);
      await waitForDead(join(environment.IOS_FIXTURE_ROOT, 'compiler.pid'));
      await waitForDead(join(environment.IOS_FIXTURE_ROOT, 'descendant.pid'));
      expect(child.exitCode).not.toBe(0);
      expect(
        readFileSync(
          join(environment.IOS_FIXTURE_ROOT, 'github-output'),
          'utf8',
        ),
      ).toContain(`diagnostic-root=${diagnosticRoot}`);
      const execution = JSON.parse(
        readFileSync(join(diagnosticRoot, 'execution.json'), 'utf8'),
      );
      expect(execution.compilerStarted).toBe(true);
      expect(execution.aborted).toBe(true);
      expect(
        readFileSync(join(diagnosticRoot, 'xcodebuild.log'), 'utf8'),
      ).toContain('compiler-ready');
    } finally {
      terminateGroup(child);
    }
  }, 20000);

  it('cancels the actual helper through the real outer timeout wrapper', async () => {
    const environment = fixtureEnvironment('outer-timeout');
    const { child, diagnosticRoot } = await runOuterTimeout(environment);
    await waitForExit(child);
    await waitForDead(join(environment.IOS_FIXTURE_ROOT, 'compiler.pid'));
    await waitForDead(join(environment.IOS_FIXTURE_ROOT, 'descendant.pid'));
    expect(child.exitCode).not.toBe(0);
    expect(
      readFileSync(join(environment.IOS_FIXTURE_ROOT, 'github-output'), 'utf8'),
    ).toContain('timed_out=true');
    expect(existsSync(join(diagnosticRoot, 'execution.json'))).toBe(true);
  }, 20000);
});
