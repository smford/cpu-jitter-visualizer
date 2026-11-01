/**
 * Hardware Micro-Jitter & Thermal Throttle Visualizer
 * Telemetry & Statistics Engine (jitter-engine.js)
 *
 * Collects timing samples from workers, computes statistical percentiles (P50, P90, P99, P99.9),
 * jitter standard deviation (sigma), context switch rates, and thermal throttling index.
 */

export class JitterEngine {
  constructor(options = {}) {
    this.timeWindowSeconds = options.timeWindowSeconds || 10;
    this.maxWindowSeconds = 60;
    this.coreCount = options.coreCount || 8;

    // Per-core rolling history: coreId => Array of { t, durationUs, jitterUs, anomaly }
    this.coreHistories = new Map();
    this.coreBaselines = new Map(); // coreId => { coldMs, rollingMs }
    this.coreStats = new Map(); // coreId => detailed metrics
    this.coreIsolation = new Map(); // coreId => boolean

    // Global aggregated recent samples for percentiles (reservoir)
    this.recentJitters = [];
    this.maxReservoirSize = 4000;

    // CS event rate tracking
    this.csEvents = []; // timestamps of context switch events
    this.anomalyLog = []; // recent anomaly events
    this.maxAnomalyLogSize = 250;

    // Global calculated metrics
    this.metrics = {
      p50JitterUs: 0,
      p90JitterUs: 0,
      p99JitterUs: 0,
      p999JitterUs: 0,
      sigmaJitterUs: 0,
      meanJitterUs: 0,
      contextSwitchRate: 0,
      totalContextSwitches: 0,
      totalSamples: 0,
      thermalThrottleIndex: 0, // % slowdown
      effectiveClockPercent: 100, // % of cold baseline speed
      activeCores: 0
    };

    this.onAnomalyCallback = null;
    this.initCores(this.coreCount);
  }

  initCores(count) {
    this.coreCount = count;
    this.coreHistories.clear();
    this.coreBaselines.clear();
    this.coreStats.clear();
    this.coreIsolation.clear();
    this.recentJitters = [];
    this.csEvents = [];
    this.anomalyLog = [];

    for (let c = 0; c < count; c++) {
      this.coreHistories.set(c, []);
      this.coreBaselines.set(c, { coldMs: 0.5, rollingMs: 0.5 });
      this.coreIsolation.set(c, false);
      this.coreStats.set(c, {
        currentJitterUs: 0,
        currentDurationUs: 0,
        sampleCount: 0,
        csCount: 0,
        p50Us: 0,
        p99Us: 0,
        throttlePercent: 0,
        status: 'calibrating'
      });
    }
  }

  setCoreCount(count) {
    this.initCores(count);
  }

  setTimeWindow(seconds) {
    this.timeWindowSeconds = Math.max(2, Math.min(60, seconds));
  }

  setCoreIsolation(coreId, isIsolated) {
    this.coreIsolation.set(coreId, isIsolated);
  }

  isCoreIsolated(coreId) {
    return !!this.coreIsolation.get(coreId);
  }

  setBaseline(coreId, coldMs) {
    const base = this.coreBaselines.get(coreId) || { coldMs, rollingMs: coldMs };
    base.coldMs = coldMs;
    base.rollingMs = coldMs;
    this.coreBaselines.set(coreId, base);

    const stats = this.coreStats.get(coreId);
    if (stats) {
      stats.status = 'active';
    }
  }

  setAnomalyCallback(cb) {
    this.onAnomalyCallback = cb;
  }

  /**
   * Ingest a batch of samples from worker (either extracted from SharedArrayBuffer or postMessage)
   * Samples format: array/typedArray of [tMs, durationUs, jitterUs, anomalyCode, ...]
   */
  ingestSamples(coreId, samplesBuffer, count) {
    if (this.isCoreIsolated(coreId)) return;

    let history = this.coreHistories.get(coreId);
    if (!history) {
      history = [];
      this.coreHistories.set(coreId, history);
    }

    const baseline = this.coreBaselines.get(coreId) || { coldMs: 0.5, rollingMs: 0.5 };
    const stats = this.coreStats.get(coreId);

    const stride = 4;
    const len = count * stride;
    const now = performance.now();

    for (let i = 0; i < len; i += stride) {
      const t = samplesBuffer[i + 0];
      const durationUs = samplesBuffer[i + 1];
      const jitterUs = samplesBuffer[i + 2];
      const anomaly = samplesBuffer[i + 3] | 0;

      const sample = { t, durationUs, jitterUs, anomaly };
      history.push(sample);

      // Add to reservoir for percentiles
      if (this.recentJitters.length < this.maxReservoirSize) {
        this.recentJitters.push(jitterUs);
      } else {
        // Fast reservoir replacement
        const rIdx = (Math.random() * this.maxReservoirSize) | 0;
        this.recentJitters[rIdx] = jitterUs;
      }

      this.metrics.totalSamples++;
      if (stats) {
        stats.sampleCount++;
        stats.currentJitterUs = jitterUs;
        stats.currentDurationUs = durationUs;
      }

      // Check for anomalies
      if (anomaly === 3) {
        // Context switch
        this.csEvents.push(now);
        this.metrics.totalContextSwitches++;
        if (stats) stats.csCount++;

        this.recordAnomalyEvent({
          timestamp: t,
          wallTime: new Date().toLocaleTimeString(),
          coreId,
          type: 'context_switch',
          durationMs: (durationUs / 1000).toFixed(2),
          jitterUs: Math.round(jitterUs),
          description: `Kernel Thread Preemption Spike (+${Math.round(jitterUs).toLocaleString()} µs)`
        });
      } else if (anomaly === 4) {
        // Sustained thermal throttling degradation
        this.recordAnomalyEvent({
          timestamp: t,
          wallTime: new Date().toLocaleTimeString(),
          coreId,
          type: 'thermal_throttle',
          durationMs: (durationUs / 1000).toFixed(2),
          jitterUs: Math.round(jitterUs),
          description: `CPU Thermal Throttling Clock Drift Detected`
        });
      }
    }

    // Prune history to time window + 2 second buffer
    const cutoffTime = history.length > 0 ? history[history.length - 1].t - (this.timeWindowSeconds * 1000 + 2000) : 0;
    if (cutoffTime > 0 && history.length > 100) {
      let pruneIdx = 0;
      while (pruneIdx < history.length && history[pruneIdx].t < cutoffTime) {
        pruneIdx++;
      }
      if (pruneIdx > 0) {
        history.splice(0, pruneIdx);
      }
    }
  }

  updateRollingBaseline(coreId, rollingMs) {
    const base = this.coreBaselines.get(coreId);
    if (base && rollingMs > 0) {
      base.rollingMs = rollingMs;
      const throttlePercent = Math.max(0, ((rollingMs - base.coldMs) / base.coldMs) * 100);
      const stats = this.coreStats.get(coreId);
      if (stats) {
        stats.throttlePercent = throttlePercent;
      }
    }
  }

  recordAnomalyEvent(event) {
    this.anomalyLog.unshift(event);
    if (this.anomalyLog.length > this.maxAnomalyLogSize) {
      this.anomalyLog.pop();
    }
    if (typeof this.onAnomalyCallback === 'function') {
      this.onAnomalyCallback(event);
    }
  }

  /**
   * Recalculate statistical metrics (called periodically, e.g. at 10 Hz)
   */
  computeMetrics() {
    const now = performance.now();

    // 1. Context switch rate over the last 2 seconds
    const csWindowMs = 2000;
    while (this.csEvents.length > 0 && now - this.csEvents[0] > csWindowMs) {
      this.csEvents.shift();
    }
    this.metrics.contextSwitchRate = (this.csEvents.length / (csWindowMs / 1000));

    // 2. Percentiles from recent samples
    if (this.recentJitters.length > 10) {
      const sorted = this.recentJitters.slice().sort((a, b) => a - b);
      const n = sorted.length;

      const p50Idx = Math.floor(n * 0.50);
      const p90Idx = Math.floor(n * 0.90);
      const p99Idx = Math.floor(n * 0.99);
      const p999Idx = Math.min(n - 1, Math.floor(n * 0.999));

      this.metrics.p50JitterUs = sorted[p50Idx] || 0;
      this.metrics.p90JitterUs = sorted[p90Idx] || 0;
      this.metrics.p99JitterUs = sorted[p99Idx] || 0;
      this.metrics.p999JitterUs = sorted[p999Idx] || 0;

      // Mean & Standard Deviation (sigma)
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += sorted[i];
      }
      const mean = sum / n;
      this.metrics.meanJitterUs = mean;

      let varianceSum = 0;
      for (let i = 0; i < n; i++) {
        const diff = sorted[i] - mean;
        varianceSum += diff * diff;
      }
      this.metrics.sigmaJitterUs = Math.sqrt(varianceSum / n);
    }

    // 3. Thermal Throttling Index & Effective Clock
    let totalThrottle = 0;
    let activeCoreCount = 0;
    let baselineRatioSum = 0;

    for (let c = 0; c < this.coreCount; c++) {
      if (this.isCoreIsolated(c)) continue;
      activeCoreCount++;

      const base = this.coreBaselines.get(c);
      if (base && base.coldMs > 0 && base.rollingMs > 0) {
        const coreSlowdown = Math.max(0, ((base.rollingMs - base.coldMs) / base.coldMs) * 100);
        totalThrottle += coreSlowdown;
        baselineRatioSum += (base.coldMs / base.rollingMs);
      }
    }

    this.metrics.activeCores = activeCoreCount;
    if (activeCoreCount > 0) {
      this.metrics.thermalThrottleIndex = totalThrottle / activeCoreCount;
      this.metrics.effectiveClockPercent = Math.min(100, Math.max(20, (baselineRatioSum / activeCoreCount) * 100));
    } else {
      this.metrics.thermalThrottleIndex = 0;
      this.metrics.effectiveClockPercent = 100;
    }

    return this.metrics;
  }

  getMetrics() {
    return this.metrics;
  }

  getCoreHistory(coreId) {
    return this.coreHistories.get(coreId) || [];
  }

  getCoreStats(coreId) {
    return this.coreStats.get(coreId);
  }

  getCoreBaseline(coreId) {
    return this.coreBaselines.get(coreId);
  }

  getAnomalyLog() {
    return this.anomalyLog;
  }

  clear() {
    this.initCores(this.coreCount);
  }
}
