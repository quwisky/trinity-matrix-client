import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import type { NativeTargetPoint } from './maestro-target-point.mts';

/*
 * Native touch for the message-swipe suite: Android's own `input motionevent`
 * DOWN/MOVE/UP/CANCEL on the touchscreen at device coordinates. No renderer
 * event is ever dispatched. CSS points are mapped to the device with the same
 * read-only transform native taps use (`client.nativeRect`), measured over the
 * timeline scroller; every point must lie inside that measured box.
 */

export interface CssPoint {
  readonly x: number;
  readonly y: number;
}

export interface DeviceMap {
  readonly css: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly factorX: number;
  readonly factorY: number;
  readonly origin: NativeTargetPoint;
  toDevice(point: CssPoint): NativeTargetPoint;
}

/** Pure affine mapping from a CSS rectangle and its inset native corners. */
export function deviceMapFrom(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  native: { readonly topLeft: NativeTargetPoint; readonly bottomRight: NativeTargetPoint },
): DeviceMap {
  const factorX = (native.bottomRight.x - native.topLeft.x) / (rect.width - 1);
  const factorY = (native.bottomRight.y - native.topLeft.y) / (rect.height - 1);
  assert(Number.isFinite(factorX) && Number.isFinite(factorY) && factorX > 0 && factorY > 0,
    'The native mapping has a positive finite scale');
  assert(Math.abs(factorX - factorY) / factorX < 0.01, 'The native mapping is uniform');
  const css = { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
  return {
    css,
    factorX,
    factorY,
    origin: native.topLeft,
    toDevice(point) {
      assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'A gesture point is finite');
      assert(point.x >= css.left && point.x <= css.right && point.y >= css.top && point.y <= css.bottom,
        'A gesture point lies inside the measured timeline box');
      return {
        x: Math.round(native.topLeft.x + (point.x - rect.x - 0.5) * factorX),
        y: Math.round(native.topLeft.y + (point.y - rect.y - 0.5) * factorY),
      };
    },
  };
}

/** Measure the timeline scroller and derive the CSS-to-device mapping, read-only. */
export async function measureDeviceMap(client: AccountWorkspaceClient): Promise<DeviceMap> {
  const scroller = await client.visible('.scroll');
  const native = await client.nativeRect(scroller.rect);
  return deviceMapFrom(scroller.rect, native);
}

export interface MotionPhase {
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly css: CssPoint;
  readonly device: NativeTargetPoint;
}

export interface MotionCommand {
  readonly phases: readonly MotionPhase[];
  readonly startedAtMs: number;
  readonly durationMs: number;
}

/** Linear CSS path of `steps` moves after `from`, like the predecessor's 10-step swipe. */
export function linearPath(from: CssPoint, to: CssPoint, steps = 10): readonly CssPoint[] {
  assert(Number.isInteger(steps) && steps >= 2 && steps <= 40, 'A path has 2–40 steps');
  return Array.from({ length: steps }, (_, index) => ({
    x: from.x + ((to.x - from.x) * (index + 1)) / steps,
    y: from.y + ((to.y - from.y) * (index + 1)) / steps,
  }));
}

/** The exact device command for a batch of phases; coordinates are integers. */
export function motionCommand(phases: readonly MotionPhase[]): string {
  assert(phases.length > 0 && phases.length <= 42, 'A motion batch has 1–42 phases');
  return phases.map(({ phase, device }) => {
    assert(Number.isInteger(device.x) && Number.isInteger(device.y) && device.x >= 0 && device.y >= 0,
      'Device coordinates are nonnegative integers');
    return `input motionevent ${phase.toUpperCase()} ${device.x} ${device.y}`;
  }).join('; ');
}

/**
 * One native touch pointer. `press` puts it down and moves it; `moveTo` moves
 * a held pointer; `release` lifts it; `dispose` cancels a pointer that is still
 * down, so a failed observation never leaves the device with a stuck touch.
 */
export class NativeTouch {
  private current: CssPoint | null = null;
  private readonly commands: MotionCommand[] = [];

  readonly client: AccountWorkspaceClient;
  readonly map: DeviceMap;

  constructor(client: AccountWorkspaceClient, map: DeviceMap) {
    this.client = client;
    this.map = map;
  }

  get held(): boolean { return this.current !== null; }

  get log(): readonly MotionCommand[] { return this.commands; }

  private async run(phases: readonly MotionPhase[]): Promise<void> {
    this.client.signal.throwIfAborted();
    const startedAtMs = performance.now();
    await this.client.device.adb('shell', motionCommand(phases));
    this.commands.push({ phases, startedAtMs, durationMs: performance.now() - startedAtMs });
  }

  private phase(phase: MotionPhase['phase'], css: CssPoint): MotionPhase {
    return { phase, css, device: this.map.toDevice(css) };
  }

  async press(from: CssPoint, to: CssPoint, steps = 10): Promise<void> {
    assert(!this.held, 'Only one native touch is down at a time');
    const phases = [this.phase('down', from), ...linearPath(from, to, steps).map((point) => this.phase('move', point))];
    this.current = from;
    await this.run(phases);
    this.current = to;
  }

  async moveTo(to: CssPoint, steps = 10): Promise<void> {
    assert(this.current, 'A held native touch moves');
    const phases = linearPath(this.current, to, steps).map((point) => this.phase('move', point));
    await this.run(phases);
    this.current = to;
  }

  async release(): Promise<void> {
    assert(this.current, 'A held native touch is released');
    const at = this.current;
    await this.run([this.phase('up', at)]);
    this.current = null;
  }

  /** A complete swipe: down, the interpolated path, and up. */
  async swipe(from: CssPoint, to: CssPoint, steps = 10): Promise<void> {
    assert(!this.held, 'Only one native touch is down at a time');
    const phases = [
      this.phase('down', from),
      ...linearPath(from, to, steps).map((point) => this.phase('move', point)),
      this.phase('up', to),
    ];
    await this.run(phases);
  }

  /** Bounded teardown: cancel a pointer that is still down. */
  async dispose(): Promise<void> {
    const at = this.current;
    if (!at) return;
    this.current = null;
    await this.client.device.adb('shell', motionCommand([this.phase('cancel', at)]));
  }
}
