/**
 * Hardware Micro-Jitter & Thermal Throttle Visualizer
 * Real-Time 60 FPS Multi-Lane Waterfall Heatmap (waterfall-canvas.js)
 *
 * Renders independent horizontal lanes per CPU core with color-mapped micro-jitter heatmaps,
 * context-switch spike waveforms, thermal throttle indicators, and interactive hover inspection.
 */

export class WaterfallCanvas {
  constructor(canvasElement, jitterEngine, options = {}) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d', { alpha: false });
    this.engine = jitterEngine;

    this.timeWindowSeconds = options.timeWindowSeconds || 10;
    this.viewMode = options.viewMode || 'heatmap_waveform'; // 'heatmap_waveform' | 'spectrogram' | 'waveform'
    this.onCoreToggleCallback = options.onCoreToggle || null;

    // Viewport & DPI management
    this.width = 1200;
    this.height = 600;
    this.dpr = window.devicePixelRatio || 1;

    // Layout configuration
    this.headerWidth = 140; // width of pinned per-core left stats column
    this.rulerHeight = 26; // height of bottom time ruler

    // Animation & rendering state
    this.rafId = null;
    this.isRendering = false;
    this.hoverPos = null; // { x, y, coreId, timeOffset, sample }

    this.initEvents();
    this.resize();
  }

  initEvents() {
    window.addEventListener('resize', () => this.resize());

    // Mouse hover inspection
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;
      this.updateHover(clientX, clientY);
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoverPos = null;
    });

    // Click on lane header to toggle core isolation
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      if (clientX <= this.headerWidth) {
        const coreCount = this.engine.coreCount;
        const availableHeight = this.height - this.rulerHeight;
        const laneHeight = availableHeight / coreCount;
        const coreId = Math.floor(clientY / laneHeight);

        if (coreId >= 0 && coreId < coreCount && typeof this.onCoreToggleCallback === 'function') {
          this.onCoreToggleCallback(coreId);
        }
      }
    });
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = Math.max(400, Math.floor(rect.width));
    this.height = Math.max(300, Math.floor(rect.height || 540));
    this.dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.scale(this.dpr, this.dpr);
  }

  setTimeWindow(seconds) {
    this.timeWindowSeconds = seconds;
  }

  setViewMode(mode) {
    this.viewMode = mode;
  }

  start() {
    if (this.isRendering) return;
    this.isRendering = true;

    const renderLoop = () => {
      if (!this.isRendering) return;
      this.render();
      this.rafId = requestAnimationFrame(renderLoop);
    };

    this.rafId = requestAnimationFrame(renderLoop);
  }

  stop() {
    this.isRendering = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  updateHover(x, y) {
    const availableHeight = this.height - this.rulerHeight;
    const coreCount = this.engine.coreCount;
    const laneHeight = availableHeight / coreCount;

    if (y > availableHeight || x < this.headerWidth) {
      this.hoverPos = null;
      return;
    }

    const coreId = Math.floor(y / laneHeight);
    if (coreId < 0 || coreId >= coreCount) {
      this.hoverPos = null;
      return;
    }

    const waterfallWidth = this.width - this.headerWidth;
    const normX = (x - this.headerWidth) / waterfallWidth; // 0 (oldest) to 1 (newest)
    const timeOffsetSec = (1 - normX) * this.timeWindowSeconds;

    // Find closest sample in core's history
    const history = this.engine.getCoreHistory(coreId);
    let closestSample = null;
    if (history.length > 0) {
      const latestTime = history[history.length - 1].t;
      const targetTime = latestTime - (timeOffsetSec * 1000);

      // Binary search closest sample
      let low = 0;
      let high = history.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (history[mid].t < targetTime) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      const idx = Math.max(0, Math.min(history.length - 1, low));
      closestSample = history[idx];
    }

    this.hoverPos = {
      x,
      y,
      coreId,
      timeOffsetSec,
      sample: closestSample
    };
  }

  /**
   * Color-mapping function according to microsecond jitter
   * Deep Navy (<15µs) -> Cyan/Green (15-60µs) -> Yellow/Orange (60-300µs) -> Crimson (>500µs)
   */
  getJitterColor(jitterUs, anomalyCode) {
    if (anomalyCode === 4) {
      // Thermal Throttle Clock Degradation: Purple strobe
      return 'rgba(168, 85, 247, 0.95)';
    }

    if (anomalyCode === 3 || jitterUs >= 500) {
      // Context Switch / Preemption: Hot Neon Crimson / Magenta
      return 'rgb(255, 0, 85)';
    }

    if (jitterUs <= 15) {
      // Calm baseline: Deep Navy / Obsidian Blue
      const ratio = Math.max(0, jitterUs / 15);
      const r = Math.round(6 + ratio * 8);
      const g = Math.round(20 + ratio * 30);
      const b = Math.round(45 + ratio * 55);
      return `rgb(${r}, ${g}, ${b})`;
    } else if (jitterUs <= 60) {
      // Nominal variance: Turquoise / Electric Cyan
      const ratio = (jitterUs - 15) / 45;
      const r = Math.round(14 + ratio * 0);
      const g = Math.round(50 + ratio * 190);
      const b = Math.round(100 + ratio * 155);
      return `rgb(${r}, ${g}, ${b})`;
    } else if (jitterUs <= 250) {
      // Cache Contention / Migration: Bright Yellow -> Orange
      const ratio = (jitterUs - 60) / 190;
      const r = Math.round(0 + ratio * 255);
      const g = Math.round(240 - ratio * 80);
      const b = Math.round(180 - ratio * 180);
      return `rgb(${r}, ${g}, ${b})`;
    } else {
      // High jitter: Amber -> Red
      const ratio = Math.min(1.0, (jitterUs - 250) / 250);
      const r = 255;
      const g = Math.round(140 * (1 - ratio));
      const b = 0;
      return `rgb(${r}, ${g}, ${b})`;
    }
  }

  render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const coreCount = this.engine.coreCount;
    const availableHeight = h - this.rulerHeight;
    const laneHeight = availableHeight / coreCount;
    const waterfallWidth = w - this.headerWidth;
    const windowMs = this.timeWindowSeconds * 1000;

    // 1. Clear background (Obsidian Dark)
    ctx.fillStyle = '#080a0f';
    ctx.fillRect(0, 0, w, h);

    // 2. Render each core lane
    for (let c = 0; c < coreCount; c++) {
      const laneY = c * laneHeight;
      const isIsolated = this.engine.isCoreIsolated(c);
      const history = this.engine.getCoreHistory(c);
      const stats = this.engine.getCoreStats(c);
      const baseline = this.engine.getCoreBaseline(c);

      // Alternating subtle lane background
      ctx.fillStyle = c % 2 === 0 ? '#0b0f19' : '#0e1422';
      ctx.fillRect(this.headerWidth, laneY, waterfallWidth, laneHeight);

      // Lane separator line
      ctx.strokeStyle = '#161f30';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, laneY + laneHeight);
      ctx.lineTo(w, laneY + laneHeight);
      ctx.stroke();

      // Render samples if core is active
      if (!isIsolated && history.length > 0) {
        const latestSampleTime = history[history.length - 1].t;
        const windowStartTime = latestSampleTime - windowMs;

        // Render Heatmap or Waveform
        if (this.viewMode === 'spectrogram') {
          this.renderSpectrogramLane(ctx, history, windowStartTime, latestSampleTime, laneY, laneHeight, waterfallWidth);
        } else if (this.viewMode === 'waveform') {
          this.renderWaveformLane(ctx, history, windowStartTime, latestSampleTime, laneY, laneHeight, waterfallWidth);
        } else {
          // Default: Heatmap + Waveform hybrid
          this.renderHybridLane(ctx, history, windowStartTime, latestSampleTime, laneY, laneHeight, waterfallWidth);
        }
      } else if (isIsolated) {
        // Isolated lane overlay
        ctx.fillStyle = 'rgba(15, 20, 30, 0.7)';
        ctx.fillRect(this.headerWidth, laneY, waterfallWidth, laneHeight);

        ctx.fillStyle = '#64748b';
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.fillText('CORE ISOLATED / PAUSED', this.headerWidth + 20, laneY + laneHeight / 2 + 4);
      }

      // Render Pinned Lane Header Column (Left side)
      this.renderLaneHeader(ctx, c, laneY, laneHeight, isIsolated, stats, baseline);
    }

    // 3. Render Bottom Time Ruler
    this.renderTimeRuler(ctx, w, h, waterfallWidth);

    // 4. Render Hover Crosshair & Tooltip (if active)
    if (this.hoverPos) {
      this.renderHoverCrosshair(ctx, this.hoverPos, laneHeight);
    }
  }

  renderLaneHeader(ctx, coreId, laneY, laneHeight, isIsolated, stats, baseline) {
    const colW = this.headerWidth;

    // Header background with right border
    ctx.fillStyle = isIsolated ? '#090d14' : '#0d131f';
    ctx.fillRect(0, laneY, colW, laneHeight);

    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(colW, laneY);
    ctx.lineTo(colW, laneY + laneHeight);
    ctx.stroke();

    // Core ID badge
    ctx.fillStyle = isIsolated ? '#64748b' : '#00f0ff';
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    const coreLabel = `CORE #${coreId.toString().padStart(2, '0')}`;
    ctx.fillText(coreLabel, 10, laneY + Math.min(18, laneHeight * 0.35));

    // Status pill / Click toggle button
    const pillX = colW - 55;
    const pillY = laneY + 5;
    ctx.fillStyle = isIsolated ? '#334155' : '#00ff9d22';
    ctx.strokeStyle = isIsolated ? '#475569' : '#00ff9d66';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(pillX, pillY, 46, 15, 3) : ctx.rect(pillX, pillY, 46, 15);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isIsolated ? '#94a3b8' : '#00ff9d';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(isIsolated ? 'MUTE' : 'LIVE', pillX + 11, pillY + 11);

    // Current jitter & stats readout
    if (laneHeight >= 40) {
      const jitterUs = stats ? stats.currentJitterUs : 0;
      const csCount = stats ? stats.csCount : 0;

      ctx.fillStyle = jitterUs > 500 ? '#ff0055' : jitterUs > 60 ? '#ffd600' : '#94a3b8';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText(`Δ ${Math.round(jitterUs)} µs`, 10, laneY + Math.min(33, laneHeight * 0.65));

      if (laneHeight >= 55) {
        ctx.fillStyle = '#64748b';
        ctx.font = '9px "JetBrains Mono", monospace';
        const baseCold = baseline ? baseline.coldMs.toFixed(2) : '0.50';
        ctx.fillText(`base:${baseCold}ms CS:${csCount}`, 10, laneY + Math.min(48, laneHeight * 0.9));
      }
    }
  }

  renderHybridLane(ctx, history, windowStart, windowEnd, laneY, laneHeight, waterfallWidth) {
    const windowSpan = windowEnd - windowStart || 1;
    const startX = this.headerWidth;
    const bottomY = laneY + laneHeight;

    // Draw background heatmap bars
    const sampleWidth = Math.max(2, waterfallWidth / Math.min(history.length, 1200));

    for (let i = 0; i < history.length; i++) {
      const s = history[i];
      if (s.t < windowStart) continue;

      const normX = (s.t - windowStart) / windowSpan;
      const x = startX + normX * waterfallWidth;

      // Color based on jitter
      ctx.fillStyle = this.getJitterColor(s.jitterUs, s.anomaly);

      // Height modulation (logarithmic: small jitters stay low, context switch spikes shoot to top)
      const logNorm = Math.min(1.0, Math.log10(s.jitterUs + 1) / Math.log10(4000));
      const spikeHeight = Math.max(3, logNorm * (laneHeight - 4));
      const y = bottomY - spikeHeight;

      ctx.fillRect(x, y, sampleWidth, spikeHeight);

      // Highlight context switch spikes (>500µs) with radiant diamond pip
      if (s.anomaly === 3 || s.jitterUs >= 500) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 1, laneY + 2, 3, 5);

        ctx.strokeStyle = '#ff0055';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, laneY + 2);
        ctx.lineTo(x, bottomY);
        ctx.stroke();
      }
    }
  }

  renderSpectrogramLane(ctx, history, windowStart, windowEnd, laneY, laneHeight, waterfallWidth) {
    const windowSpan = windowEnd - windowStart || 1;
    const startX = this.headerWidth;
    const sampleWidth = Math.max(2, waterfallWidth / Math.min(history.length, 1000));

    for (let i = 0; i < history.length; i++) {
      const s = history[i];
      if (s.t < windowStart) continue;

      const normX = (s.t - windowStart) / windowSpan;
      const x = startX + normX * waterfallWidth;

      ctx.fillStyle = this.getJitterColor(s.jitterUs, s.anomaly);
      ctx.fillRect(x, laneY + 2, sampleWidth, laneHeight - 4);
    }
  }

  renderWaveformLane(ctx, history, windowStart, windowEnd, laneY, laneHeight, waterfallWidth) {
    const windowSpan = windowEnd - windowStart || 1;
    const startX = this.headerWidth;
    const bottomY = laneY + laneHeight;

    ctx.beginPath();
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 1.5;

    let started = false;
    for (let i = 0; i < history.length; i++) {
      const s = history[i];
      if (s.t < windowStart) continue;

      const normX = (s.t - windowStart) / windowSpan;
      const x = startX + normX * waterfallWidth;
      const logNorm = Math.min(1.0, Math.log10(s.jitterUs + 1) / Math.log10(4000));
      const y = bottomY - (logNorm * (laneHeight - 6));

      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  renderTimeRuler(ctx, w, h, waterfallWidth) {
    const rulerY = h - this.rulerHeight;
    const startX = this.headerWidth;

    // Ruler background
    ctx.fillStyle = '#06080d';
    ctx.fillRect(0, rulerY, w, this.rulerHeight);

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerY);
    ctx.lineTo(w, rulerY);
    ctx.stroke();

    // Time ticks
    const tickCount = 6;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';

    for (let i = 0; i <= tickCount; i++) {
      const frac = i / tickCount;
      const x = startX + frac * waterfallWidth;
      const secAgo = (1 - frac) * this.timeWindowSeconds;

      // Tick mark
      ctx.strokeStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(x, rulerY);
      ctx.lineTo(x, rulerY + 5);
      ctx.stroke();

      // Label
      const label = secAgo === 0 ? 'NOW' : `-${secAgo.toFixed(secAgo < 10 ? 1 : 0)}s`;
      ctx.fillText(label, x, rulerY + 18);
    }
    ctx.textAlign = 'left';
  }

  renderHoverCrosshair(ctx, hover, laneHeight) {
    const x = hover.x;
    const y = hover.y;
    const laneY = hover.coreId * laneHeight;

    // Vertical crosshair line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.height - this.rulerHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    // Highlight hovered lane bounds
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.headerWidth, laneY, this.width - this.headerWidth, laneHeight);

    // Tooltip popup
    if (hover.sample) {
      const s = hover.sample;
      const tipW = 200;
      const tipH = 75;
      let tipX = x + 15;
      let tipY = y - tipH - 10;

      if (tipX + tipW > this.width) tipX = x - tipW - 15;
      if (tipY < 10) tipY = y + 15;

      ctx.fillStyle = 'rgba(10, 15, 25, 0.95)';
      ctx.strokeStyle = s.anomaly === 3 ? '#ff0055' : s.anomaly === 4 ? '#a855f7' : '#00f0ff';
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(tipX, tipY, tipW, tipH, 4) : ctx.rect(tipX, tipY, tipW, tipH);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.fillText(`Core #${hover.coreId.toString().padStart(2, '0')} (${hover.timeOffsetSec.toFixed(2)}s ago)`, tipX + 8, tipY + 16);

      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`Duration: ${(s.durationUs / 1000).toFixed(3)} ms`, tipX + 8, tipY + 32);

      ctx.fillStyle = s.jitterUs > 500 ? '#ff0055' : s.jitterUs > 60 ? '#ffd600' : '#00ff9d';
      ctx.fillText(`Jitter: +${Math.round(s.jitterUs).toLocaleString()} µs`, tipX + 8, tipY + 47);

      const anomalyLabels = ['Nominal Baseline', 'Minor Variance', 'L3 Contention', 'OS Preemption Spike', 'Thermal Throttle'];
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Class: ${anomalyLabels[s.anomaly] || 'Unknown'}`, tipX + 8, tipY + 62);
    }
  }
}
