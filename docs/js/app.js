/**
 * Hardware Micro-Jitter & Thermal Throttle Visualizer
 * Main Application Controller (app.js)
 *
 * Coordinates Web Workers, Shared Memory ring buffers, statistical compute loop,
 * real-time canvas waterfall rendering, SRE dashboard telemetry updates, and UI events.
 */

import { JitterEngine } from './jitter-engine.js';
import { WorkerManager } from './worker-manager.js';
import { WaterfallCanvas } from './waterfall-canvas.js';
import { AudioSynth } from './audio-synth.js';
import { ExportUtil } from './export-util.js';

class App {
  constructor() {
    this.detectedCores = Math.min(32, Math.max(1, navigator.hardwareConcurrency || 8));
    this.selectedCoreCount = this.detectedCores;
    this.benchmarkStartTime = 0;
    this.elapsedSeconds = 0;
    this.metricsTimerId = null;
    this.eventFilter = 'all'; // 'all' | 'context_switch' | 'thermal_throttle'

    // Initialize modules
    this.engine = new JitterEngine({ coreCount: this.selectedCoreCount });
    this.workerManager = new WorkerManager(this.engine, { coreCount: this.selectedCoreCount });
    this.audioSynth = new AudioSynth();

    const canvasElement = document.getElementById('waterfall-canvas');
    this.visualizer = new WaterfallCanvas(canvasElement, this.engine, {
      timeWindowSeconds: 10,
      viewMode: 'heatmap_waveform',
      onCoreToggle: (coreId) => this.toggleCore(coreId)
    });

    this.engine.setAnomalyCallback((event) => this.handleAnomalyEvent(event));

    this.initDOM();
    this.bindEvents();
    this.renderCoresGrid();
    this.updateIsolationBadges();
  }

  initDOM() {
    // Cache UI elements
    this.btnStart = document.getElementById('btn-start');
    this.btnPause = document.getElementById('btn-pause');
    this.btnRecalibrate = document.getElementById('btn-recalibrate');
    this.btnAudio = document.getElementById('btn-audio');
    this.btnExportJson = document.getElementById('btn-export-json');
    this.btnExportCsv = document.getElementById('btn-export-csv');
    this.btnInfoModal = document.getElementById('btn-info-modal');
    this.btnCloseModal = document.getElementById('btn-close-modal');
    this.infoModal = document.getElementById('info-modal');

    this.coreSelect = document.getElementById('core-count-select');
    this.timeWindowSelect = document.getElementById('time-window-select');
    this.viewModeSelect = document.getElementById('view-mode-select');

    // Telemetry display elements
    this.valP50 = document.getElementById('val-p50');
    this.valP90 = document.getElementById('val-p90');
    this.valP99 = document.getElementById('val-p99');
    this.valP999 = document.getElementById('val-p999');
    this.valSigma = document.getElementById('val-sigma');
    this.valCsRate = document.getElementById('val-cs-rate');
    this.valCsTotal = document.getElementById('val-cs-total');
    this.valThermalIndex = document.getElementById('val-thermal-index');
    this.valEffectiveClock = document.getElementById('val-effective-clock');
    this.valRuntime = document.getElementById('val-runtime');
    this.valSampleCount = document.getElementById('val-sample-count');

    this.coresGrid = document.getElementById('cores-grid');
    this.anomalyLogContainer = document.getElementById('anomaly-log');

    // Populate core count selector options (1 to 32)
    this.coreSelect.innerHTML = '';
    const coreOptions = [1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32];
    if (!coreOptions.includes(this.detectedCores)) {
      coreOptions.push(this.detectedCores);
      coreOptions.sort((a, b) => a - b);
    }
    for (const count of coreOptions) {
      const opt = document.createElement('option');
      opt.value = count;
      opt.textContent = `${count} Cores ${count === this.detectedCores ? '(Detected)' : ''}`;
      if (count === this.selectedCoreCount) opt.selected = true;
      this.coreSelect.appendChild(opt);
    }
  }

  updateIsolationBadges() {
    const badgeContainer = document.getElementById('isolation-badge-container');
    const status = this.workerManager.getIsolationStatus();

    if (status.crossOriginIsolated) {
      badgeContainer.innerHTML = `
        <span class="badge badge-success" title="High-precision timers and zero-allocation SharedArrayBuffer enabled via COOP/COEP">
          <span class="badge-dot"></span> COOP/COEP ISOLATED (SharedArrayBuffer & Atomics)
        </span>
        <span class="badge badge-info">
          &lt; 5µs Timer Precision
        </span>
      `;
    } else {
      badgeContainer.innerHTML = `
        <span class="badge badge-warning" title="Running in zero-blocking Transferable ArrayBuffer fallback. Page will auto-upgrade on reload via coi-serviceworker.">
          <span class="badge-dot-amber"></span> STANDALONE FALLBACK MODE (Transferable ArrayBuffers)
        </span>
        <span class="badge badge-info">
          ~20µs Spectre-Protected
        </span>
      `;
    }
  }

  bindEvents() {
    // Start button
    this.btnStart.addEventListener('click', () => {
      this.startBenchmark();
    });

    // Pause button
    this.btnPause.addEventListener('click', () => {
      this.pauseBenchmark();
    });

    // Recalibrate button
    this.btnRecalibrate.addEventListener('click', () => {
      this.workerManager.recalibrate();
    });

    // Workload profile buttons
    const profileButtons = document.querySelectorAll('.profile-btn');
    profileButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        profileButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const profile = btn.dataset.profile;
        this.workerManager.setProfile(profile);
      });
    });

    // Core count selector
    this.coreSelect.addEventListener('change', (e) => {
      const newCount = parseInt(e.target.value, 10);
      this.selectedCoreCount = newCount;
      this.workerManager.setCoreCount(newCount);
      this.renderCoresGrid();
    });

    // Time window selector
    this.timeWindowSelect.addEventListener('change', (e) => {
      const windowSec = parseInt(e.target.value, 10);
      this.engine.setTimeWindow(windowSec);
      this.visualizer.setTimeWindow(windowSec);
    });

    // View mode selector
    this.viewModeSelect.addEventListener('change', (e) => {
      this.visualizer.setViewMode(e.target.value);
    });

    // Audio Sonification Toggle
    this.btnAudio.addEventListener('click', () => {
      const isEnabled = this.audioSynth.toggle();
      this.btnAudio.classList.toggle('active', isEnabled);
      this.btnAudio.innerHTML = isEnabled
        ? '<span class="icon">🔊</span> Preemption Audio: ON'
        : '<span class="icon">🔇</span> Preemption Audio: MUTED';
    });

    // Exports
    this.btnExportJson.addEventListener('click', () => {
      ExportUtil.exportJSON(this.engine, this.workerManager, Math.round(this.elapsedSeconds));
    });

    this.btnExportCsv.addEventListener('click', () => {
      ExportUtil.exportCSV(this.engine, this.workerManager);
    });

    // Anomaly event filters
    const filterChips = document.querySelectorAll('.filter-chip');
    filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.eventFilter = chip.dataset.filter;
        this.refreshAnomalyLogDOM();
      });
    });

    // Info modal
    this.btnInfoModal.addEventListener('click', () => {
      this.infoModal.classList.add('visible');
    });

    this.btnCloseModal.addEventListener('click', () => {
      this.infoModal.classList.remove('visible');
    });

    this.infoModal.addEventListener('click', (e) => {
      if (e.target === this.infoModal) {
        this.infoModal.classList.remove('visible');
      }
    });
  }

  startBenchmark() {
    this.btnStart.classList.add('active');
    this.btnPause.classList.remove('active');
    this.benchmarkStartTime = performance.now();

    this.workerManager.start();
    this.visualizer.start();

    if (this.metricsTimerId) clearInterval(this.metricsTimerId);
    this.metricsTimerId = setInterval(() => this.updateTelemetryLoop(), 100);
  }

  pauseBenchmark() {
    this.btnStart.classList.remove('active');
    this.btnPause.classList.add('active');

    this.workerManager.pause();
    this.visualizer.stop();

    if (this.metricsTimerId) {
      clearInterval(this.metricsTimerId);
      this.metricsTimerId = null;
    }
  }

  toggleCore(coreId) {
    const isIsolated = this.workerManager.toggleCoreIsolation(coreId);
    const card = document.getElementById(`core-card-${coreId}`);
    if (card) {
      card.classList.toggle('isolated', isIsolated);
      const btn = card.querySelector('.btn-isolate');
      if (btn) btn.textContent = isIsolated ? 'Unmute' : 'Isolate';
    }
  }

  handleAnomalyEvent(event) {
    if (event.type === 'context_switch') {
      this.audioSynth.playContextSwitch(event.coreId);
    } else if (event.type === 'thermal_throttle') {
      this.audioSynth.playThermalAlert();
    }
    this.appendAnomalyToDOM(event);
  }

  appendAnomalyToDOM(event) {
    if (this.eventFilter !== 'all' && event.type !== this.eventFilter) return;

    const row = document.createElement('div');
    row.className = `log-entry ${event.type}`;
    const badgeClass = event.type === 'context_switch' ? 'badge-danger' : 'badge-purple';
    const tag = event.type === 'context_switch' ? 'PREEMPTION' : 'THROTTLE';

    row.innerHTML = `
      <span class="log-time">${event.wallTime}</span>
      <span class="badge ${badgeClass}">${tag}</span>
      <span class="log-core">Core #${event.coreId.toString().padStart(2, '0')}</span>
      <span class="log-desc">${event.description}</span>
      <span class="log-dur">${event.durationMs}ms</span>
    `;

    this.anomalyLogContainer.insertBefore(row, this.anomalyLogContainer.firstChild);

    // Keep max 80 elements in DOM to maintain silky smoothness
    while (this.anomalyLogContainer.children.length > 80) {
      this.anomalyLogContainer.removeChild(this.anomalyLogContainer.lastChild);
    }
  }

  refreshAnomalyLogDOM() {
    this.anomalyLogContainer.innerHTML = '';
    const logs = this.engine.getAnomalyLog();
    for (const event of logs) {
      if (this.eventFilter === 'all' || event.type === this.eventFilter) {
        const row = document.createElement('div');
        row.className = `log-entry ${event.type}`;
        const badgeClass = event.type === 'context_switch' ? 'badge-danger' : 'badge-purple';
        const tag = event.type === 'context_switch' ? 'PREEMPTION' : 'THROTTLE';

        row.innerHTML = `
          <span class="log-time">${event.wallTime}</span>
          <span class="badge ${badgeClass}">${tag}</span>
          <span class="log-core">Core #${event.coreId.toString().padStart(2, '0')}</span>
          <span class="log-desc">${event.description}</span>
          <span class="log-dur">${event.durationMs}ms</span>
        `;
        this.anomalyLogContainer.appendChild(row);
      }
    }
  }

  renderCoresGrid() {
    this.coresGrid.innerHTML = '';
    for (let c = 0; c < this.selectedCoreCount; c++) {
      const card = document.createElement('div');
      card.id = `core-card-${c}`;
      card.className = 'core-card';
      const isIsolated = this.engine.isCoreIsolated(c);
      if (isIsolated) card.classList.add('isolated');

      card.innerHTML = `
        <div class="core-card-header">
          <div class="core-title">
            <span class="core-indicator"></span>
            <strong>CORE #${c.toString().padStart(2, '0')}</strong>
          </div>
          <button class="btn-isolate" data-core="${c}">${isIsolated ? 'Unmute' : 'Isolate'}</button>
        </div>
        <div class="core-card-metrics">
          <div class="core-metric-item">
            <span class="metric-lbl">Jitter</span>
            <span class="metric-val jitter-val" id="card-jitter-${c}">0 µs</span>
          </div>
          <div class="core-metric-item">
            <span class="metric-lbl">Cold Base</span>
            <span class="metric-val" id="card-base-${c}">0.50 ms</span>
          </div>
          <div class="core-metric-item">
            <span class="metric-lbl">CS Events</span>
            <span class="metric-val" id="card-cs-${c}">0</span>
          </div>
          <div class="core-metric-item">
            <span class="metric-lbl">Slowdown</span>
            <span class="metric-val throttle-val" id="card-throttle-${c}">0.0%</span>
          </div>
        </div>
        <div class="core-bar-wrapper">
          <div class="core-bar" id="card-bar-${c}"></div>
        </div>
      `;

      card.querySelector('.btn-isolate').addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleCore(c);
      });

      this.coresGrid.appendChild(card);
    }
  }

  updateTelemetryLoop() {
    const metrics = this.engine.computeMetrics();

    // Update Elapsed Runtime
    this.elapsedSeconds += 0.1;
    const mins = Math.floor(this.elapsedSeconds / 60);
    const secs = (this.elapsedSeconds % 60).toFixed(1);
    this.valRuntime.textContent = `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;

    // Update Primary HUD Gauges
    this.valP50.textContent = `${Math.round(metrics.p50JitterUs).toLocaleString()} µs`;
    this.valP90.textContent = `${Math.round(metrics.p90JitterUs).toLocaleString()} µs`;
    this.valP99.textContent = `${Math.round(metrics.p99JitterUs).toLocaleString()} µs`;
    this.valP999.textContent = `${Math.round(metrics.p999JitterUs).toLocaleString()} µs`;

    this.valSigma.textContent = `±${metrics.sigmaJitterUs.toFixed(1)} µs`;
    this.valCsRate.textContent = `${metrics.contextSwitchRate.toFixed(1)}/s`;
    this.valCsTotal.textContent = `${metrics.totalContextSwitches.toLocaleString()} total`;
    this.valSampleCount.textContent = metrics.totalSamples.toLocaleString();

    // Thermal Throttle Index
    const tti = metrics.thermalThrottleIndex;
    this.valThermalIndex.textContent = `${tti.toFixed(1)}%`;
    const ttiCard = document.getElementById('card-hud-throttle');
    if (ttiCard) {
      ttiCard.classList.toggle('alert-amber', tti >= 10 && tti < 25);
      ttiCard.classList.toggle('alert-crimson', tti >= 25);
    }

    // Effective Clock Rating
    this.valEffectiveClock.textContent = `${metrics.effectiveClockPercent.toFixed(1)}%`;

    // Update Per-Core Cards
    for (let c = 0; c < this.selectedCoreCount; c++) {
      const stats = this.engine.getCoreStats(c);
      const baseline = this.engine.getCoreBaseline(c);

      const jitterEl = document.getElementById(`card-jitter-${c}`);
      const baseEl = document.getElementById(`card-base-${c}`);
      const csEl = document.getElementById(`card-cs-${c}`);
      const throttleEl = document.getElementById(`card-throttle-${c}`);
      const barEl = document.getElementById(`card-bar-${c}`);

      if (stats && jitterEl && barEl) {
        const jUs = Math.round(stats.currentJitterUs);
        jitterEl.textContent = `${jUs} µs`;
        jitterEl.className = 'metric-val jitter-val ' + (jUs > 500 ? 'text-danger' : jUs > 60 ? 'text-amber' : 'text-cyan');

        if (csEl) csEl.textContent = stats.csCount;
        if (baseEl && baseline) baseEl.textContent = `${baseline.coldMs.toFixed(3)} ms`;

        if (throttleEl) {
          throttleEl.textContent = `${stats.throttlePercent.toFixed(1)}%`;
          throttleEl.className = 'metric-val throttle-val ' + (stats.throttlePercent > 15 ? 'text-purple' : '');
        }

        // Mini bar indicator (log scale)
        const barPct = Math.min(100, Math.max(3, (Math.log10(jUs + 1) / Math.log10(3000)) * 100));
        barEl.style.width = `${barPct}%`;
        barEl.style.background = jUs > 500 ? '#ff0055' : jUs > 60 ? '#ffd600' : '#00f0ff';
      }
    }
  }
}

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.__jitterApp = new App();
  // Auto-start benchmark immediately so user sees live telemetry without having to click
  window.__jitterApp.startBenchmark();
});
