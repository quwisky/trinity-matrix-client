import { Injectable, inject } from '@angular/core';
import { NotificationSoundService } from '@trinity/data-access/notifications';

const BURST_PERIOD_MS = 3000;
const PEAK_GAIN = 0.15;
const TONES_HZ = [440, 480];
const BURST_SECONDS = 1;

/** A repeating two-tone ring: about 1 s on, 2 s off. Silent when the sound preference is off. */
@Injectable({ providedIn: 'root' })
export class RingToneService {
  private readonly sound = inject(NotificationSoundService);
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.context || !this.sound.enabled()) return;
    try {
      this.context = new AudioContext();
      // Made without a gesture it starts suspended.
      void this.context.resume?.().catch(() => undefined);
    } catch {
      return;
    }
    this.burst();
    this.timer = setInterval(() => this.burst(), BURST_PERIOD_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private burst(): void {
    const context = this.context;
    if (!context) return;
    const at = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN / TONES_HZ.length, at + 0.05);
    gain.gain.linearRampToValueAtTime(0, at + BURST_SECONDS);
    gain.connect(context.destination);
    for (const hz of TONES_HZ) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(hz, at);
      oscillator.connect(gain);
      oscillator.start(at);
      oscillator.stop(at + BURST_SECONDS);
    }
  }
}
