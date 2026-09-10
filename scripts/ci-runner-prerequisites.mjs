#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const toolRoot = join(root, 'dist/.ci/runner-tools');
const chromeVersion = '153.0.8010.36';
const electronDriverVersion = '150.0.7871.129';
const maestroVersion = '2.10.0';

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok)
    throw new Error(`download failed (${response.status}): ${url}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function extract(zip, destination) {
  mkdirSync(destination, { recursive: true });
  await exec('unzip', ['-q', '-o', zip, '-d', destination], { cwd: root });
}

async function installChromeTools() {
  const archive = join(toolRoot, `chrome-${chromeVersion}.zip`);
  await download(
    `https://storage.googleapis.com/chrome-for-testing-public/${chromeVersion}/linux64/chrome-linux64.zip`,
    archive,
  );
  await extract(archive, toolRoot);
  const driverArchive = join(toolRoot, `chromedriver-${chromeVersion}.zip`);
  await download(
    `https://storage.googleapis.com/chrome-for-testing-public/${chromeVersion}/linux64/chromedriver-linux64.zip`,
    driverArchive,
  );
  await extract(driverArchive, toolRoot);
  return {
    chrome: join(toolRoot, 'chrome-linux64/chrome'),
    chromedriver: join(toolRoot, 'chromedriver-linux64/chromedriver'),
  };
}

async function installElectronDriver() {
  const archive = join(
    toolRoot,
    `electron-chromedriver-${electronDriverVersion}.zip`,
  );
  await download(
    `https://storage.googleapis.com/chrome-for-testing-public/${electronDriverVersion}/linux64/chromedriver-linux64.zip`,
    archive,
  );
  const destination = join(toolRoot, 'electron-chromedriver');
  await extract(archive, destination);
  return join(destination, 'chromedriver-linux64/chromedriver');
}

async function installMaestro() {
  const archive = join(toolRoot, `maestro-${maestroVersion}.zip`);
  await download(
    `https://github.com/mobile-dev-inc/maestro/releases/download/cli-${maestroVersion}/maestro.zip`,
    archive,
  );
  const destination = join(toolRoot, 'maestro');
  await extract(archive, destination);
  const candidates = [
    join(destination, 'bin/maestro'),
    join(destination, 'maestro/bin/maestro'),
  ];
  const { access } = await import('node:fs/promises');
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next archive layout.
    }
  }
  throw new Error(`Maestro ${maestroVersion} archive has no executable`);
}

async function verifyVersion(command, expected) {
  const result = await exec(command, ['--version']);
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expected)) {
    throw new Error(
      `${command} reported ${output.trim() || '<no version>'}; expected ${expected}`,
    );
  }
}

async function main() {
  mkdirSync(toolRoot, { recursive: true });
  const mode = process.argv[2] ?? 'all';
  if (!['all', 'chromium', 'electron', 'maestro'].includes(mode)) {
    throw new Error(
      'usage: ci-runner-prerequisites.mjs [all|chromium|electron|maestro]',
    );
  }
  const chrome =
    mode === 'electron' || mode === 'maestro'
      ? undefined
      : await installChromeTools();
  const electronChromedriver =
    mode === 'chromium' || mode === 'maestro'
      ? undefined
      : await installElectronDriver();
  const maestro =
    mode === 'chromium' || mode === 'electron'
      ? undefined
      : await installMaestro();
  const files = [
    chrome?.chrome,
    chrome?.chromedriver,
    electronChromedriver,
    maestro,
  ].filter((file) => file !== undefined);
  for (const file of files) {
    await exec('chmod', ['+x', file]);
  }
  if (chrome) {
    await verifyVersion(chrome.chrome, chromeVersion);
    await verifyVersion(chrome.chromedriver, chromeVersion);
  }
  if (electronChromedriver)
    await verifyVersion(electronChromedriver, electronDriverVersion);
  if (maestro) await verifyVersion(maestro, maestroVersion);
  const environment = process.env['GITHUB_ENV'];
  if (environment) {
    const values = [
      chrome && `TRINITY_CHROME_BINARY=${chrome.chrome}`,
      chrome && `TRINITY_CHROMEDRIVER_BINARY=${chrome.chromedriver}`,
      electronChromedriver &&
        `TRINITY_ELECTRON_CHROMEDRIVER_BINARY=${electronChromedriver}`,
      maestro && `MAESTRO_CLI=${maestro}`,
    ].filter((value) => value !== undefined);
    writeFileSync(environment, `${values.join('\n')}\n`, { flag: 'a' });
  }
  console.log(
    `Installed runner prerequisites (${mode}): Chrome ${chrome ? chromeVersion : 'n/a'}, Electron ChromeDriver ${electronChromedriver ? electronDriverVersion : 'n/a'}, Maestro ${maestro ? maestroVersion : 'n/a'}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
