/**
 * Hardware Micro-Jitter & Thermal Throttle Visualizer
 * Worker Execution Engine (jitter-worker.js)
 *
 * Runs deterministic non-allocating micro-loop calibration epochs,
 * measures high-resolution execution duration via performance.now(),
 * classifies scheduling anomalies (OS context switches, L3 cache contention, thermal throttling),
 * and streams telemetry into SharedArrayBuffer with Atomics (or falls back to postMessage).
 */

let coreId = 0;
let isRunning = false;
let isIsolated = false;
let profile = 'heavy'; // 'passive' | 'balanced' | 'heavy' | 'turbo'
let iterations = 50000;

// Calibration & baseline variables
let baselineColdMs = 0.5;
let rollingBaselineMs = 0.5;
let isCalibrated = false;

// Shared Memory configuration
let useSharedMemory = false;
let sharedBuffer = null;
let controlInt32View = null;
let ringFloat32View = null;
let ringCapacity = 1024;
let writePointerIndex = 0;
let csCounterIndex = 0;
let sampleCounterIndex = 0;
let localWriteHead = 0;

// Fallback telemetry buffer (when SharedArrayBuffer is unavailable)
const FALLBACK_BATCH_SIZE = 64;
let fallbackBuffer = new Float32Array(FALLBACK_BATCH_SIZE * 4);
let fallbackIndex = 0;
let lastFlushTime = performance.now();
let totalContextSwitches = 0;
let totalSamples = 0;

// Benchmark start timestamp reference
let benchmarkStartTime = performance.now();

// Fast deterministic non-allocating arithmetic loop
function executeEpoch(iters, isTurbo) {
  let state = (0x85ebca6b ^ (coreId * 0x9e3779b9)) | 0;
  let fState = 1.00001;

  if (isTurbo) {
    // Turbo profile: unrolled bit-mixing + float math to draw peak power & induce thermal throttling
    for (let i = 0; i < iters; i++) {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      fState = (fState * 1.00002 + 0.00001);
      if (fState > 1000.0) fState -= 1000.0;
    }
  } else {
    // Standard stress profile: bitwise XOR-shift & LCG multiplication
    for (let i = 0; i < iters; i++) {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    }
  }

  return (state ^ (fState | 0)) | 0;
}

// Calibration phase: establish cold baseline execution latency
function calibrateBaseline() {
  const testSamples = [];
  const warmupCount = 15;
  const sampleCount = 60;

  // Warmup loop
  for (let i = 0; i < warmupCount; i++) {
    executeEpoch(iterations, false);
  }

  // Measurement loop
  for (let i = 0; i < sampleCount; i++) {
    const t0 = performance.now();
    executeEpoch(iterations, false);
    const t1 = performance.now();
    const duration = t1 - t0;
    if (duration > 0.001) {
      testSamples.push(duration);
    }
  }

  testSamples.sort((a, b) => a - b);
  // Pick 10th percentile to establish cold baseline free of scheduler spikes
  const p10Idx = Math.max(0, Math.floor(testSamples.length * 0.10));
  baselineColdMs = testSamples[p10Idx] || 0.25;
  rollingBaselineMs = baselineColdMs;
  isCalibrated = true;

  self.postMessage({
    type: 'calibrated',
    coreId,
    baselineColdMs,
    iterations
  });
}

// Anomaly classification:
// 0 = Baseline Calm (<15 µs)
// 1 = Nominal Variance (15 - 60 µs)
// 2 = Cache Contention / Migration (60 - 400 µs)
// 3 = OS Context Switch / Preemption (> 500 µs or duration > 1.8 * baseline + 0.4ms)
// 4 = Thermal Throttle Degradation (> 15% sustained baseline degradation)
function classifyAnomaly(durationMs, jitterUs) {
  // Check for OS Kernel Preemption / Context switch first (isolated spike)
  const isPreemption = jitterUs >= 500 || (durationMs > baselineColdMs * 1.8 + 0.4);
  if (isPreemption) {
    return 3;
  }

  // Check for sustained thermal throttling clock degradation
  const thermalDegradation = (rollingBaselineMs - baselineColdMs) / baselineColdMs;
  if (thermalDegradation >= 0.15) {
    return 4;
  }

  // Fine-grained jitter classification
  if (jitterUs <= 15) {
    return 0; // Baseline calm
  } else if (jitterUs <= 60) {
    return 1; // Nominal variance
  } else {
    return 2; // Cache contention / thread migration
  }
}

// Record a single epoch sample
function recordSample(timestampMs, durationUs, jitterUs, anomalyCode) {
  totalSamples++;
  if (anomalyCode === 3) {
    totalContextSwitches++;
  }

  if (useSharedMemory && ringFloat32View && controlInt32View) {
    // Write directly into pre-allocated SharedArrayBuffer ring partition
    localWriteHead = (localWriteHead + 1) % ringCapacity;
    const offset = localWriteHead * 4;
    ringFloat32View[offset + 0] = timestampMs;
    ringFloat32View[offset + 1] = durationUs;
    ringFloat32View[offset + 2] = jitterUs;
    ringFloat32View[offset + 3] = anomalyCode;

    // Atomically publish write head and counters
    Atomics.store(controlInt32View, writePointerIndex, localWriteHead);
    if (anomalyCode === 3) {
      Atomics.add(controlInt32View, csCounterIndex, 1);
    }
    Atomics.add(controlInt32View, sampleCounterIndex, 1);
  } else {
    // Fallback mode: batch into typed array and transfer/postMessage
    const offset = fallbackIndex * 4;
    fallbackBuffer[offset + 0] = timestampMs;
    fallbackBuffer[offset + 1] = durationUs;
    fallbackBuffer[offset + 2] = jitterUs;
    fallbackBuffer[offset + 3] = anomalyCode;
    fallbackIndex++;

    const now = performance.now();
    if (fallbackIndex >= FALLBACK_BATCH_SIZE || (now - lastFlushTime >= 16 && fallbackIndex > 0)) {
      flushFallbackBuffer();
      lastFlushTime = now;
    }
  }
}

function flushFallbackBuffer() {
  if (fallbackIndex === 0) return;
  const chunk = fallbackBuffer.slice(0, fallbackIndex * 4);
  self.postMessage({
    type: 'batch',
    coreId,
    samples: chunk,
    sampleCount: fallbackIndex,
    csCount: totalContextSwitches,
    rollingBaselineMs
  }, [chunk.buffer]);
  fallbackIndex = 0;
}

// Worker execution step
function runWorkCycle() {
  if (!isRunning) return;

  // Check if core is isolated / paused
  if (isIsolated) {
    setTimeout(runWorkCycle, 50);
    return;
  }

  const isTurbo = profile === 'turbo';
  let batchCount = 1;
  let sleepDelayMs = 0;

  switch (profile) {
    case 'passive':
      // 5% duty cycle: 1 epoch execution (~0.2-0.5ms), then sleep ~19ms
      batchCount = 1;
      sleepDelayMs = 19;
      break;
    case 'balanced':
      // 50% duty cycle: 2 epochs execution (~0.5-1ms), then sleep ~1ms
      batchCount = 2;
      sleepDelayMs = 1;
      break;
    case 'heavy':
      // 100% load: uninterrupted synchronous execution chunk
      batchCount = 20;
      sleepDelayMs = 0;
      break;
    case 'turbo':
      // Maximum unthrottled load: unrolled arithmetic + float stress chunk
      batchCount = 30;
      sleepDelayMs = 0;
      break;
  }

  for (let b = 0; b < batchCount; b++) {
    const t0 = performance.now();
    executeEpoch(iterations, isTurbo);
    const t1 = performance.now();

    const durationMs = t1 - t0;
    const durationUs = durationMs * 1000;
    const baselineUs = baselineColdMs * 1000;
    let jitterUs = durationUs - baselineUs;
    if (jitterUs < 0) jitterUs = 0;

    // Slowly adapt rolling baseline for low-frequency thermal drift detection
    // Ignore context switch spikes during baseline tracking
    if (durationMs < rollingBaselineMs * 1.5) {
      rollingBaselineMs = rollingBaselineMs * 0.998 + durationMs * 0.002;
    }

    const anomalyCode = classifyAnomaly(durationMs, jitterUs);
    const relTimeMs = t1 - benchmarkStartTime;

    recordSample(relTimeMs, durationUs, jitterUs, anomalyCode);
  }

  if (sleepDelayMs > 0) {
    setTimeout(runWorkCycle, sleepDelayMs);
  } else {
    // For heavy/turbo workloads, yield via microtask / immediate timer to check incoming messages
    if (typeof queueMicrotask === 'function') {
      setTimeout(runWorkCycle, 0);
    } else {
      setTimeout(runWorkCycle, 0);
    }
  }
}

// Message handler
self.onmessage = function (e) {
  const msg = e.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'init':
      coreId = msg.coreId;
      useSharedMemory = !!msg.useSharedMemory;
      profile = msg.profile || 'heavy';
      iterations = msg.iterations || 50000;
      ringCapacity = msg.ringCapacity || 1024;
      benchmarkStartTime = msg.benchmarkStartTime || performance.now();

      if (useSharedMemory && msg.sharedBuffer) {
        sharedBuffer = msg.sharedBuffer;
        // Control block view (at byte offset 0)
        controlInt32View = new Int32Array(sharedBuffer, 0, 1024);
        // Core's dedicated ring buffer partition
        // ringOffset = 4096 + coreId * (ringCapacity * 4 * 4 bytes)
        const ringByteOffset = msg.ringOffset;
        ringFloat32View = new Float32Array(sharedBuffer, ringByteOffset, ringCapacity * 4);

        writePointerIndex = 48 + coreId;
        csCounterIndex = 80 + coreId;
        sampleCounterIndex = 112 + coreId;
      }

      calibrateBaseline();
      break;

    case 'start':
      if (!isRunning) {
        isRunning = true;
        benchmarkStartTime = msg.benchmarkStartTime || benchmarkStartTime;
        runWorkCycle();
      }
      break;

    case 'stop':
      isRunning = false;
      if (!useSharedMemory) {
        flushFallbackBuffer();
      }
      break;

    case 'set_profile':
      profile = msg.profile || 'heavy';
      break;

    case 'set_isolation':
      isIsolated = !!msg.isIsolated;
      break;

    case 'recalibrate':
      calibrateBaseline();
      break;

    case 'ping':
      self.postMessage({ type: 'pong', coreId });
      break;
  }
};
