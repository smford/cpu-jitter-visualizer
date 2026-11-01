/**
 * Hardware Micro-Jitter & Thermal Throttle Visualizer
 * Acoustic Preemption Sonification / Geiger Counter (audio-synth.js)
 *
 * Provides optional real-time auditory feedback for OS thread context switches
 * and preemption spikes using Web Audio API synthesis.
 */

export class AudioSynth {
  constructor() {
    this.audioCtx = null;
    this.isEnabled = false;
    this.lastClickTime = 0;
    this.minClickIntervalMs = 25; // prevent audio clipping on burst spikes
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    if (this.isEnabled && !this.audioCtx) {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this.audioCtx = new AudioContextClass();
        }
      } catch (e) {
        console.warn('Web Audio API not supported:', e);
        this.isEnabled = false;
      }
    }

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    return this.isEnabled;
  }

  playContextSwitch(coreId = 0) {
    if (!this.isEnabled || !this.audioCtx) return;

    const now = performance.now();
    if (now - this.lastClickTime < this.minClickIntervalMs) return;
    this.lastClickTime = now;

    try {
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      // Pitch mapped subtly by core ID
      const baseFreq = 700 + (coreId % 8) * 110;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(baseFreq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.025);

      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.025);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.028);
    } catch (e) {}
  }

  playThermalAlert() {
    if (!this.isEnabled || !this.audioCtx) return;

    try {
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(220, ctx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.13);
    } catch (e) {}
  }
}
