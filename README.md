# Hardware Micro-Jitter & Thermal Throttle Visualizer

**Live Site:** [https://stephenford.org/cpu-jitter-visualizer/](https://stephenford.org/cpu-jitter-visualizer/)

A real-time systems benchmark and hardware profiling suite running in an unprivileged web page, detecting CPU micro-architectural scheduling jitter, operating system context switches, cache line contention, and thermal throttling in real time.

---

## ⚡ Concept

Modern web browsers run inside isolated security sandboxes that prohibit direct access to kernel schedulers, CPU performance counters (MSRs), or hardware thermal diodes. However, by pinning dedicated Web Workers to tight mathematical calibration epochs and measuring delta timing variations via high-resolution `performance.now()`, this application exposes the physical behavior of the host CPU and kernel scheduler directly in the browser.

### Key Capabilities
- **Multi-Core Stress Pipeline:** Spawns independent Web Workers matching `navigator.hardwareConcurrency` (configurable from 1 to 32 cores).
- **Sub-Microsecond Jitter Detection:** Runs non-allocating arithmetic loops (bitwise XOR-shift, LCG multiplication, and SHA round operations) comparing execution latency against cold calibrated baselines.
- **Kernel Preemption Detection:** Distinguishes between nominal operating variance (<60µs), L3 cache contention / core migration (60µs–300µs), and operating system kernel context switches (>500µs–5.0ms) where the OS preempts the thread.
- **Physical Thermal Throttling Tracking:** Tracks sustained baseline latency degradation across active cores as CPU thermal power management triggers frequency downclocking (P-states).
- **60 FPS Multi-Lane Waterfall Heatmap:** Real-time multi-lane canvas where each horizontal lane represents an independent CPU core, color-mapped from calm obsidian blue to bright neon crimson spikes and purple thermal strobes.
- **Zero-Allocation Shared Memory Ring Buffers:** Uses `SharedArrayBuffer` and `Atomics` for lock-free inter-thread telemetry streaming when cross-origin isolated.
- **Seamless Fallback Mode:** Gracefully falls back to Transferable ArrayBuffers and batched `postMessage` if cross-origin isolation is pending or unavailable, guaranteeing immediate zero-blocking execution.
- **Acoustic Preemption Sonification:** Optional Web Audio API synthesizer that clicks on kernel context switches like an SRE Geiger counter.
- **Comprehensive SRE Dashboard & Export:** Real-time P50, P90, P99, P99.9 latency, standard deviation ($\sigma$), context switch rates, Thermal Throttle Index, and one-click JSON/CSV data export.

---

## 🔬 Architecture

```
                                  +---------------------------------------------------+
                                  |                 Main UI Thread                    |
                                  |  - 60 FPS Multi-Lane Waterfall Canvas (2D)        |
                                  |  - SRE HUD Percentile Engine (P50/P90/P99/P99.9)  |
                                  |  - Audio Sonification Synth (Web Audio API)      |
                                  +---------------------------------------------------+
                                          |                                   ^
       Lock-Free Reads (rAF)              |                                   |  Fallback Batches
       Atomics.load(writePointer)         |                                   |  postMessage(chunk)
                                          v                                   |
              +-----------------------------------------------------+         |
              |            SharedArrayBuffer Ring Buffer            |         |
              |  - Header: Global State, Active Cores, Write Heads  |         |
              |  - Partitions: 32 Cores x 1024 Samples x 16 Bytes   |         |
              +-----------------------------------------------------+         |
                         ^                       ^                            |
         Atomics.store() |       Atomics.store() |                            |
                         |                       |                            |
               +-------------------+   +-------------------+                  |
               |   Web Worker #0   |   |   Web Worker #1   | ... Worker #N----+
               | - XOR-Shift Loop  |   | - XOR-Shift Loop  |
               | - performance.now |   | - performance.now |
               | - Anomaly Engine  |   | - Anomaly Engine  |
               +-------------------+   +-------------------+
```

### 1. Cross-Origin Isolation (COOP / COEP)
To prevent Spectre side-channel attacks, browsers restrict `SharedArrayBuffer` and reduce `performance.now()` timer resolution unless the page is cross-origin isolated. This project includes `coi-serviceworker.min.js`, which dynamically injects:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

When hosted on GitHub Pages or static hosts without server-side header configuration, the service worker enables full cross-origin isolation on reload. If running in an environment where service workers are disabled, the engine automatically operates in **Standalone Fallback Mode** using Transferable ArrayBuffers with zero interruption.

### 2. Workload Profiles
1. **Passive Micro-Jitter Monitor (5% duty cycle):** 1 calibration epoch (~0.5ms) followed by ~19ms yield. Generates negligible CPU heat; ideal for monitoring background OS scheduler preemption and interrupt latency.
2. **Balanced Profiler (50% load):** 50% duty cycle benchmark.
3. **Heavy Stress Test (100% load):** Continuous synchronous execution across all selected cores for maximum CPU utilization.
4. **Turbo Burner (Max Throttle Stress):** Unrolled arithmetic and floating-point computations designed to maximize thermal power dissipation and provoke hardware thermal throttling.

### 3. Anomaly Classification Taxonomy
| Anomaly Class | Jitter Magnitude ($\Delta t$) | Physical Cause | Waterfall Color |
|---|---|---|---|
| **Calm Baseline** | $< 15\,\mu\text{s}$ | Steady unperturbed core execution | Deep Navy / Obsidian Blue (`#06142d`) |
| **Nominal Variance** | $15\,\mu\text{s} - 60\,\mu\text{s}$ | Normal micro-architectural jitter | Electric Cyan (`#00f0ff`) |
| **Cache Contention** | $60\,\mu\text{s} - 400\,\mu\text{s}$ | L3 cache line misses / core migration | Solar Amber (`#ffd600`) |
| **Kernel Context Switch** | $> 500\,\mu\text{s}$ (0.5–5ms) | OS preemptive scheduler interrupt | Laser Crimson (`#ff0055`) |
| **Thermal Throttling** | $> 15\%$ baseline drift | Physical CPU thermal clock scaling | Purple Strobe (`#a855f7`) |

---

## 💡 Why it's Quirky

Browsers are explicitly engineered to isolate web applications from physical hardware. This tool turns the browser's high-precision timing mechanisms inside-out: by treating small timing variations not as noise, but as telemetry signals, it exposes low-level OS kernel thread scheduling, hardware interrupts, L3 cache contention, and physical CPU thermal clock scaling from within an unprivileged browser sandbox.

---

## 🛠️ Local Development

To run the application locally, serve the `docs/` directory with any static HTTP server:

```bash
# Clone the repository
git clone https://github.com/stephenford/cpu-jitter-visualizer.git
cd cpu-jitter-visualizer

# Option 1: Python 3
python3 -m http.server --directory docs 8080

# Option 2: Node.js (npx serve)
npx serve docs

# Option 3: Deno
deno run --allow-net --allow-read https://deno.land/std/http/file_server.ts docs
```

Open `http://localhost:8080` in your browser.

---

## 📄 License

MIT License. Designed and built for systems engineers, SREs, and performance enthusiasts.
