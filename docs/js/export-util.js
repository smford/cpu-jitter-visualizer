/**
 * Hardware Micro-Jitter & Thermal Throttle Visualizer
 * Benchmark Data Export Utility (export-util.js)
 *
 * Generates JSON and CSV benchmark telemetry reports with statistical percentiles,
 * hardware configuration, and per-core anomaly distributions.
 */

export class ExportUtil {
  static exportJSON(engine, workerManager, benchmarkDurationSec) {
    const metrics = engine.getMetrics();
    const isoStatus = workerManager.getIsolationStatus();
    const coreCount = engine.coreCount;

    const perCoreSummary = [];
    for (let c = 0; c < coreCount; c++) {
      const stats = engine.getCoreStats(c);
      const baseline = engine.getCoreBaseline(c);
      perCoreSummary.push({
        coreId: c,
        isIsolated: engine.isCoreIsolated(c),
        coldBaselineMs: baseline ? baseline.coldMs : 0,
        rollingBaselineMs: baseline ? baseline.rollingMs : 0,
        throttlePercent: stats ? stats.throttlePercent : 0,
        sampleCount: stats ? stats.sampleCount : 0,
        contextSwitches: stats ? stats.csCount : 0,
        currentJitterUs: stats ? stats.currentJitterUs : 0
      });
    }

    const report = {
      benchmarkName: 'Hardware Micro-Jitter & Thermal Throttle Benchmark',
      exportedAt: new Date().toISOString(),
      benchmarkDurationSeconds: benchmarkDurationSec,
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
        crossOriginIsolated: isoStatus.crossOriginIsolated,
        telemetryMethod: isoStatus.method,
        precisionNotice: isoStatus.precisionNotice
      },
      workloadProfile: workerManager.profile,
      configuredCoreCount: coreCount,
      statisticalSummary: {
        p50JitterUs: Math.round(metrics.p50JitterUs * 10) / 10,
        p90JitterUs: Math.round(metrics.p90JitterUs * 10) / 10,
        p99JitterUs: Math.round(metrics.p99JitterUs * 10) / 10,
        p999JitterUs: Math.round(metrics.p999JitterUs * 10) / 10,
        meanJitterUs: Math.round(metrics.meanJitterUs * 10) / 10,
        jitterSigmaUs: Math.round(metrics.sigmaJitterUs * 10) / 10,
        contextSwitchRatePerSec: Math.round(metrics.contextSwitchRate * 10) / 10,
        totalContextSwitches: metrics.totalContextSwitches,
        totalSamples: metrics.totalSamples,
        thermalThrottleIndexPercent: Math.round(metrics.thermalThrottleIndex * 10) / 10,
        effectiveClockPercent: Math.round(metrics.effectiveClockPercent * 10) / 10
      },
      perCoreDetails: perCoreSummary,
      anomalyEvents: engine.getAnomalyLog().slice(0, 100)
    };

    const jsonStr = JSON.stringify(report, null, 2);
    ExportUtil.downloadFile(jsonStr, `cpu-jitter-benchmark-${Date.now()}.json`, 'application/json');
  }

  static exportCSV(engine, workerManager) {
    const metrics = engine.getMetrics();
    const coreCount = engine.coreCount;

    let csv = '# CPU Micro-Jitter & Thermal Throttle Telemetry Export\n';
    csv += `# Date: ${new Date().toISOString()}\n`;
    csv += `# Profile: ${workerManager.profile}, Cores: ${coreCount}\n`;
    csv += `# P50: ${metrics.p50JitterUs.toFixed(1)} us, P90: ${metrics.p90JitterUs.toFixed(1)} us, P99: ${metrics.p99JitterUs.toFixed(1)} us, Sigma: ${metrics.sigmaJitterUs.toFixed(1)} us\n`;
    csv += `# Thermal Throttle Index: ${metrics.thermalThrottleIndex.toFixed(1)}%, Effective Clock: ${metrics.effectiveClockPercent.toFixed(1)}%\n\n`;

    // Core summary table
    csv += 'CoreId,Status,ColdBaselineMs,RollingBaselineMs,ThrottlePercent,Samples,ContextSwitches,LatestJitterUs\n';
    for (let c = 0; c < coreCount; c++) {
      const stats = engine.getCoreStats(c);
      const baseline = engine.getCoreBaseline(c);
      const status = engine.isCoreIsolated(c) ? 'ISOLATED' : 'ACTIVE';
      const cold = baseline ? baseline.coldMs.toFixed(3) : '0';
      const rolling = baseline ? baseline.rollingMs.toFixed(3) : '0';
      const throttle = stats ? stats.throttlePercent.toFixed(1) : '0';
      const samples = stats ? stats.sampleCount : 0;
      const cs = stats ? stats.csCount : 0;
      const jitter = stats ? Math.round(stats.currentJitterUs) : 0;

      csv += `${c},${status},${cold},${rolling},${throttle},${samples},${cs},${jitter}\n`;
    }

    csv += '\n# Recent Anomaly Events\n';
    csv += 'TimestampMs,WallTime,CoreId,Type,DurationMs,JitterUs,Description\n';
    const anomalies = engine.getAnomalyLog().slice(0, 150);
    for (const a of anomalies) {
      csv += `${a.timestamp},${a.wallTime},${a.coreId},${a.type},${a.durationMs},${a.jitterUs},"${a.description}"\n`;
    }

    ExportUtil.downloadFile(csv, `cpu-jitter-telemetry-${Date.now()}.csv`, 'text/csv');
  }

  static downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 150);
  }
}
