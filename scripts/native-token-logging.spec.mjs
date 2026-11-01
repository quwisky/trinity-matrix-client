import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const push = join(root, 'libs/native/capacitor-push');
const swift = join(push, 'ios/TrinityPush/Sources/TrinityPush');
const kotlin = join(
  push,
  'android/src/main/kotlin/dev/trinityproject/trinity/push',
);

const swiftNames = [
  'TokenRecord.swift',
  'TokenLease.swift',
  'TokenGrantClient.swift',
  'TokenRefresher.swift',
  'PushHandoffStore+TokenVault.swift',
];
const kotlinNames = [
  'TokenRecord.kt',
  'KeystoreTokenVault.kt',
  'HttpTokenGrantClient.kt',
  'TokenRefresher.kt',
  'TokenLeases.kt',
];

const renderers = [
  join(swift, 'PushContentResolver.swift'),
  join(swift, 'MatrixPushAPI.swift'),
  join(kotlin, 'PushResolver.kt'),
  join(kotlin, 'HttpMatrixApi.kt'),
  join(kotlin, 'BoundedPushResolver.kt'),
  join(root, 'ios/App/NotificationService/NotificationService.swift'),
  join(push, 'ios/Sources/PushHandoffPlugin/PushHandoffPlugin.swift'),
  join(
    push,
    'android/src/main/java/dev/trinityproject/trinity/PushHandoffPlugin.java',
  ),
];

const tokenFiles = [
  ...readdirSync(swift)
    .filter(
      (n) =>
        /^Token.*\.swift$/.test(n) || n === 'PushHandoffStore+TokenVault.swift',
    )
    .map((n) => join(swift, n)),
  ...readdirSync(kotlin)
    .filter((n) => /Token.*\.kt$/.test(n) || n === 'TokenLeases.kt')
    .map((n) => join(kotlin, n)),
];
const files = [...tokenFiles, ...renderers];

const logging =
  /print\(|NSLog|os_log|Logger\(|\bLog\.|println|printStackTrace|System\.(out|err)/;

describe('native token sources', () => {
  it('found every known file, so an empty glob cannot pass', () => {
    expect(tokenFiles.map((f) => f.split('/').pop()).sort()).toEqual(
      [...swiftNames, ...kotlinNames].sort(),
    );
    expect(files).toHaveLength(18);
  });

  it.each(files)('%s writes nothing to a log', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(logging);
  });

  it('keeps the refresh token out of NativeTokenResult', () => {
    const source = readFileSync(join(push, 'src/lib/definitions.ts'), 'utf8');
    const start = source.indexOf('export type NativeTokenResult');
    const definition = source.slice(start, source.indexOf(';\n', start));
    expect(start).toBeGreaterThan(-1);
    expect(definition).not.toContain('refreshToken');
  });
});
