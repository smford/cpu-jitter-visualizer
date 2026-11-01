/**
 * Hardware Micro-Jitter & Thermal Throttle Visualizer
 * Worker & Shared Memory Manager (worker-manager.js)
 *
 * Spawns dedicated Web Workers matching CPU core count, creates and partitions
 * SharedArrayBuffer ring buffers when cross-origin isolation is enabled,
 * or handles seamless transferable ArrayBuffer fallback messaging.
 */

export class WorkerManager {
  constructor(jitterEngine, options = {}) {
    this.engine = jitterEngine;
    this.coreCount = options.coreCount || Math.min(32, Math.max(1, navigator.hardwareConcurrency || 8));
    this.profile = options.profile || 'heavy'; // 'passive' | 'balanced' | 'heavy' | 'turbo'
    this.iterations = options.iterations || 50000;
    this.ringCapacity = 1024; // samples per core ring buffer

    this.workers = [];
    this.isRunning = false;
    this.benchmarkStartTime = performance.now();

    // Cross-origin isolation & SharedArrayBuffer detection
    this.isCrossIsolated = typeof window !== 'undefined' && !!window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    this.sharedBuffer = null;
    this.controlInt32View = null;
    this.ringFloat32Views = [];
    this.lastReadPointers = new Int32Array(32);

    this.pollAnimationFrameId = null;

    this.initSharedMemory();
  }

  getIsolationStatus() {
    return {
      crossOriginIsolated: this.isCrossIsolated,
      method: this.isCrossIsolated ? 'SharedArrayBuffer & Atomics' : 'Transferable ArrayBuffer Fallback',
      precisionNotice: this.isCrossIsolated ? 'Microsecond Unrounded (< 5µs)' : 'Standard Fallback (~20µs Spectre rounded)'
    };
  }

  initSharedMemory() {
    if (!this.isCrossIsolated) {
      console.info('[WorkerManager] Running in Fallback Mode (window.crossOriginIsolated is false). Using Transferable postMessage.');
      return;
    }

    try {
      const maxCores = 32;
      const headerBytes = 4096; // 1024 Int32 entries
      const perCoreRingFloats = this.ringCapacity * 4; // 1024 * 4 floats
      const perCoreRingBytes = perCoreRingFloats * 4; // 16,384 bytes
      const totalBytes = headerBytes + (maxCores * perCoreRingBytes);

      this.sharedBuffer = new SharedArrayBuffer(totalBytes);
      this.controlInt32View = new Int32Array(this.sharedBuffer, 0, 1024);

      // Initialize control header
      // Index 0: global state (0 = idle, 1 = running)
      // Index 1: active core count
      // Indices 48..79: core write pointers (initialized to -1)
      this.controlInt32View[0] = 0;
      this.controlInt32View[1] = this.coreCount;
      for (let c = 0; c < 32; c++) {
        this.controlInt32View[48 + c] = 0;
        this.lastReadPointers[c] = 0;
      }

      // Pre-create Float32 views for each core's ring buffer partition
      this.ringFloat32Views = [];
      for (let c = 0; c < maxCores; c++) {
        const ringByteOffset = headerBytes + (c * perCoreRingBytes);
        this.ringFloat32Views[c] = new Float32Array(this.sharedBuffer, ringByteOffset, perCoreRingFloats);
      }

      console.info(`[WorkerManager] Allocated SharedArrayBuffer (${Math.round(totalBytes / 1024)} KB) for lock-free atomic telemetry.`);
    } catch (err) {
      console.warn('[WorkerManager] SharedArrayBuffer initialization failed, falling back to postMessage:', err);
      this.isCrossIsolated = false;
      this.sharedBuffer = null;
    }
  }

  spawnWorkers() {
    this.terminateWorkers();
    this.workers = [];
    this.benchmarkStartTime = performance.now();

    const maxCores = 32;
    const headerBytes = 4096;
    const perCoreRingBytes = this.ringCapacity * 4 * 4;

    for (let c = 0; c < this.coreCount; c++) {
      // Relative path to worker script anchored via import.meta.url
      const workerUrl = new URL('../workers/jitter-worker.js', import.meta.url);
      const worker = new Worker(workerUrl);

      worker.onmessage = (e) => {
        const msg = e.data;
        if (!msg) return;

        if (msg.type === 'calibrated') {
          this.engine.setBaseline(msg.coreId, msg.baselineColdMs);
        } else if (msg.type === 'batch') {
          // Fallback mode postMessage payload
          this.engine.ingestSamples(msg.coreId, msg.samples, msg.sampleCount);
          if (msg.rollingBaselineMs) {
            this.engine.updateRollingBaseline(msg.coreId, msg.rollingBaselineMs);
          }
        }
      };

      worker.onerror = (err) => {
        console.error(`[Worker ${c}] Error:`, err);
      };

      // Initialize worker
      const initPayload = {
        type: 'init',
        coreId: c,
        useSharedMemory: this.isCrossIsolated,
        sharedBuffer: this.sharedBuffer,
        ringOffset: headerBytes + (c * perCoreRingBytes),
        ringCapacity: this.ringCapacity,
        profile: this.profile,
        iterations: this.iterations,
        benchmarkStartTime: this.benchmarkStartTime
      };

      worker.postMessage(initPayload);
      this.workers.push(worker);
    }
  }

  start() {
    if (this.isRunning) return;
    if (this.workers.length === 0) {
      this.spawnWorkers();
    }

    this.isRunning = true;
    this.benchmarkStartTime = performance.now();

    if (this.isCrossIsolated && this.controlInt32View) {
      this.controlInt32View[0] = 1;
    }

    for (let c = 0; c < this.workers.length; c++) {
      this.workers[c].postMessage({
        type: 'start',
        benchmarkStartTime: this.benchmarkStartTime
      });
    }

    if (this.isCrossIsolated) {
      this.startSharedMemoryDrain();
    }
  }

  pause() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.isCrossIsolated && this.controlInt32View) {
      this.controlInt32View[0] = 0;
    }

    for (let c = 0; c < this.workers.length; c++) {
      this.workers[c].postMessage({ type: 'stop' });
    }

    if (this.pollAnimationFrameId) {
      cancelAnimationFrame(this.pollAnimationFrameId);
      this.pollAnimationFrameId = null;
    }
  }

  setProfile(profile) {
    this.profile = profile;
    for (let c = 0; c < this.workers.length; c++) {
      this.workers[c].postMessage({
        type: 'set_profile',
        profile: this.profile
      });
    }
  }

  setCoreCount(newCount) {
    const validCount = Math.max(1, Math.min(32, newCount));
    if (validCount === this.coreCount) return;

    const wasRunning = this.isRunning;
    this.pause();
    this.coreCount = validCount;
    this.engine.setCoreCount(validCount);
    this.spawnWorkers();

    if (wasRunning) {
      this.start();
    }
  }

  toggleCoreIsolation(coreId) {
    const currentState = this.engine.isCoreIsolated(coreId);
    const newState = !currentState;
    this.engine.setCoreIsolation(coreId, newState);

    if (this.workers[coreId]) {
      this.workers[coreId].postMessage({
        type: 'set_isolation',
        isIsolated: newState
      });
    }

    return newState;
  }

  recalibrate() {
    for (let c = 0; c < this.workers.length; c++) {
      this.workers[c].postMessage({ type: 'recalibrate' });
    }
  }

  /**
   * Zero-allocation polling drain of SharedArrayBuffer ring buffers
   * Executed on requestAnimationFrame without blocking worker threads.
   */
  startSharedMemoryDrain() {
    const drain = () => {
      if (!this.isRunning) return;

      if (this.isCrossIsolated && this.controlInt32View) {
        for (let c = 0; c < this.coreCount; c++) {
          if (this.engine.isCoreIsolated(c)) continue;

          // Atomic load of current worker write pointer
          const writeHead = Atomics.load(this.controlInt32View, 48 + c);
          let readHead = this.lastReadPointers[c];

          if (writeHead !== readHead) {
            const ring = this.ringFloat32Views[c];
            const cap = this.ringCapacity;

            // Calculate number of new samples
            let newSamplesCount = 0;
            if (writeHead >= readHead) {
              newSamplesCount = writeHead - readHead;
            } else {
              newSamplesCount = (cap - readHead) + writeHead;
            }

            // Cap drain size to avoid huge catch-ups if UI stalled
            if (newSamplesCount > cap) {
              readHead = (writeHead - cap + cap) % cap;
              newSamplesCount = cap;
            }

            if (newSamplesCount > 0) {
              // Extract contiguous or wrapped slices
              if (readHead + newSamplesCount <= cap) {
                // Single contiguous segment
                const startIdx = readHead * 4;
                const endIdx = (readHead + newSamplesCount) * 4;
                const slice = ring.subarray(startIdx, endIdx);
                this.engine.ingestSamples(c, slice, newSamplesCount);
              } else {
                // Two segments around ring boundary
                const firstPartCount = cap - readHead;
                const secondPartCount = newSamplesCount - firstPartCount;

                const slice1 = ring.subarray(readHead * 4, cap * 4);
                this.engine.ingestSamples(c, slice1, firstPartCount);

                const slice2 = ring.subarray(0, secondPartCount * 4);
                this.engine.ingestSamples(c, slice2, secondPartCount);
              }

              this.lastReadPointers[c] = writeHead;
            }
          }
        }
      }

      this.pollAnimationFrameId = requestAnimationFrame(drain);
    };

    this.pollAnimationFrameId = requestAnimationFrame(drain);
  }

  terminateWorkers() {
    if (this.pollAnimationFrameId) {
      cancelAnimationFrame(this.pollAnimationFrameId);
      this.pollAnimationFrameId = null;
    }

    for (let c = 0; c < this.workers.length; c++) {
      try {
        this.workers[c].terminate();
      } catch (e) {}
    }
    this.workers = [];
  }
}
