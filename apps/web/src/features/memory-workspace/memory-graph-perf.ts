/**
 * Minimal frame-time harness for the 3D memory graph (#62).
 *
 * Enabled with `?graphperf` in the URL. Records requestAnimationFrame deltas
 * and exposes p50/p95/max on `window.__memoryGraphPerf`, e.g.:
 *
 *   open http://127.0.0.1:4911/demo-workspace?graphperf, switch Memory to 3D,
 *   rotate/zoom for a while, then read `window.__memoryGraphPerf.snapshot()`.
 */

export type GraphPerfSnapshot = {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  nodeCount: number;
  edgeCount: number;
  renderer: string;
};

const percentile = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export class GraphPerfRecorder {
  private deltas: number[] = [];
  private last = 0;
  private renderer = "unknown";
  private nodeCount = 0;
  private edgeCount = 0;

  configure(renderer: string, nodeCount: number, edgeCount: number) {
    this.renderer = renderer;
    this.nodeCount = nodeCount;
    this.edgeCount = edgeCount;
  }

  frame(now: number) {
    if (this.last > 0) {
      this.deltas.push(now - this.last);
      if (this.deltas.length > 3600) this.deltas.shift();
    }
    this.last = now;
  }

  snapshot(): GraphPerfSnapshot {
    const sorted = [...this.deltas].sort((a, b) => a - b);
    return {
      frames: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.length ? sorted[sorted.length - 1]! : 0,
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      renderer: this.renderer
    };
  }

  reset() {
    this.deltas = [];
    this.last = 0;
  }
}

export function graphPerfEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("graphperf");
  } catch {
    return false;
  }
}

declare global {
  interface Window {
    __memoryGraphPerf?: { recorder: GraphPerfRecorder; snapshot: () => GraphPerfSnapshot };
  }
}

export function installGraphPerf(recorder: GraphPerfRecorder) {
  if (typeof window === "undefined" || !graphPerfEnabled()) return;
  window.__memoryGraphPerf = { recorder, snapshot: () => recorder.snapshot() };
  console.info("[memory-graph] perf harness enabled: window.__memoryGraphPerf.snapshot()");
}
