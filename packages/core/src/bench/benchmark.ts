/**
 * Benchmarks comparing supertalk vs Comlink performance.
 *
 * Run with: npm run bench -w @supertalk/core
 *
 * NOTE: Uses CALLS_PER_ITERATION to batch multiple RPC calls per timing measurement.
 * This reduces benchmark harness overhead and gives stable, meaningful results.
 * Without batching, JIT/GC effects dominate and produce misleading variance.
 *
 * @packageDocumentation
 */

import {MessageChannel, type MessagePort} from 'node:worker_threads';
import {expose, wrap, type Remote} from '../index.js';
import * as Comlink from 'comlink';
// @ts-expect-error - Comlink's node adapter has no types
import nodeEndpoint from 'comlink/dist/esm/node-adapter.mjs';

// ============================================================
// Types
// ============================================================

interface BenchmarkResult {
  name: string;
  library: 'supertalk' | 'supertalk-autoproxy' | 'comlink';
  iterations: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
}

interface BenchmarkSuite {
  name: string;
  results: Array<BenchmarkResult>;
}

// ============================================================
// Utilities
// ============================================================

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', {maximumFractionDigits: 2});
}

function formatResult(result: BenchmarkResult): string {
  const libName =
    result.library === 'supertalk-autoproxy' ? 'st-auto' : result.library;
  return `  ${libName.padEnd(10)} ${formatNumber(result.opsPerSec).padStart(12)} ops/sec  (${formatNumber(result.avgMs)} ms/op)`;
}

function printSuite(suite: BenchmarkSuite): void {
  console.log(`\n📊 ${suite.name}`);
  console.log('─'.repeat(60));
  for (const result of suite.results) {
    console.log(formatResult(result));
  }

  const supertalk = suite.results.find((r) => r.library === 'supertalk');
  const comlink = suite.results.find((r) => r.library === 'comlink');
  const autoProxy = suite.results.find(
    (r) => r.library === 'supertalk-autoproxy',
  );

  // Show comparisons
  if (supertalk && comlink) {
    const ratio = supertalk.opsPerSec / comlink.opsPerSec;
    const comparison =
      ratio > 1
        ? `supertalk is ${formatNumber(ratio)}x faster than comlink`
        : `comlink is ${formatNumber(1 / ratio)}x faster than supertalk`;
    console.log(`  → ${comparison}`);
  }
  if (supertalk && autoProxy) {
    const ratio = autoProxy.opsPerSec / supertalk.opsPerSec;
    // Ratios within 25% of 1.0 are likely measurement noise for simple ops
    // See ROADMAP.md "Known Issues" - variance between runs exceeds config difference
    const isNoise = ratio > 0.8 && ratio < 1.25;
    const suffix = isNoise ? ' (noise)' : ratio < 0.8 ? '' : ' ⚠️';
    console.log(`  → auto/st: ${formatNumber(ratio)}x${suffix}`);
  }
}

async function runBenchmark(
  name: string,
  library: 'supertalk' | 'supertalk-autoproxy' | 'comlink',
  iterations: number,
  fn: () => Promise<void>,
): Promise<BenchmarkResult> {
  // Warmup
  for (let i = 0; i < Math.min(100, iterations / 10); i++) {
    await fn();
  }

  // Actual benchmark
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const totalMs = performance.now() - start;

  return {
    name,
    library,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    opsPerSec: (iterations / totalMs) * 1000,
  };
}

// Number of calls per iteration - reduces benchmark harness overhead
// relative to the actual RPC work being measured
const CALLS_PER_ITERATION = 10;

/**
 * Run three benchmarks with interleaved iterations to minimize JIT/GC variance.
 * All functions are warmed up together, then iterations rotate between them.
 * Each function should perform CALLS_PER_ITERATION calls internally.
 */
async function runTripleBenchmark(
  name: string,
  iterations: number,
  stFn: () => Promise<void>,
  stAutoFn: () => Promise<void>,
  clFn: () => Promise<void>,
): Promise<[BenchmarkResult, BenchmarkResult, BenchmarkResult]> {
  // Interleaved warmup to stabilize JIT
  // Scale warmup with iterations - heavy benchmarks need less warmup
  const warmupCount = Math.max(50, Math.min(500, iterations / 5));
  for (let i = 0; i < warmupCount; i++) {
    await stFn();
    await stAutoFn();
    await clFn();
  }

  // Interleaved benchmark - rotate order each iteration for fairness
  let stTotal = 0;
  let stAutoTotal = 0;
  let clTotal = 0;

  for (let i = 0; i < iterations; i++) {
    // Rotate starting position: 0->st first, 1->stAuto first, 2->cl first
    const order = i % 3;

    if (order === 0) {
      const t1 = performance.now();
      await stFn();
      stTotal += performance.now() - t1;

      const t2 = performance.now();
      await stAutoFn();
      stAutoTotal += performance.now() - t2;

      const t3 = performance.now();
      await clFn();
      clTotal += performance.now() - t3;
    } else if (order === 1) {
      const t2 = performance.now();
      await stAutoFn();
      stAutoTotal += performance.now() - t2;

      const t3 = performance.now();
      await clFn();
      clTotal += performance.now() - t3;

      const t1 = performance.now();
      await stFn();
      stTotal += performance.now() - t1;
    } else {
      const t3 = performance.now();
      await clFn();
      clTotal += performance.now() - t3;

      const t1 = performance.now();
      await stFn();
      stTotal += performance.now() - t1;

      const t2 = performance.now();
      await stAutoFn();
      stAutoTotal += performance.now() - t2;
    }
  }

  const totalCalls = iterations * CALLS_PER_ITERATION;

  const stResult: BenchmarkResult = {
    name,
    library: 'supertalk',
    iterations: totalCalls,
    totalMs: stTotal,
    avgMs: stTotal / totalCalls,
    opsPerSec: (totalCalls / stTotal) * 1000,
  };

  const stAutoResult: BenchmarkResult = {
    name,
    library: 'supertalk-autoproxy',
    iterations: totalCalls,
    totalMs: stAutoTotal,
    avgMs: stAutoTotal / totalCalls,
    opsPerSec: (totalCalls / stAutoTotal) * 1000,
  };

  const clResult: BenchmarkResult = {
    name,
    library: 'comlink',
    iterations: totalCalls,
    totalMs: clTotal,
    avgMs: clTotal / totalCalls,
    opsPerSec: (totalCalls / clTotal) * 1000,
  };

  return [stResult, stAutoResult, clResult];
}

// ============================================================
// Setup helpers
// ============================================================

interface SupertalkContext<T extends object> {
  remote: Remote<T>;
  cleanup: () => void;
}

function setupSupertalk<T extends object>(
  service: T,
  options: {autoProxy?: boolean; debug?: boolean} = {},
): SupertalkContext<T> {
  const {port1, port2} = new MessageChannel();
  expose(service, port1, options);
  const remote = wrap<T>(port2, options);
  return {
    remote,
    cleanup: () => {
      port1.close();
      port2.close();
    },
  };
}

interface ComlinkContext<T> {
  remote: Comlink.Remote<T>;
  cleanup: () => void;
}

function setupComlink<T>(service: T): ComlinkContext<T> {
  const {port1, port2} = new MessageChannel();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- nodeEndpoint has no types
  Comlink.expose(service, nodeEndpoint(port1 as unknown as MessagePort));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- nodeEndpoint has no types
  const remote = Comlink.wrap<T>(nodeEndpoint(port2 as unknown as MessagePort));
  return {
    remote,
    cleanup: () => {
      port1.close();
      port2.close();
    },
  };
}

// ============================================================
// Benchmark: Simple string echo
// ============================================================

async function benchSimpleString(): Promise<BenchmarkSuite> {
  const iterations = 10000;

  const service = {
    echo(s: string): string {
      return s;
    },
  };

  const st = setupSupertalk(service);
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const cl = setupComlink(service);

  const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
    'simple-string',
    iterations,
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await st.remote.echo('hello');
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await stAuto.remote.echo('hello');
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await cl.remote.echo('hello');
      }
    },
  );

  st.cleanup();
  stAuto.cleanup();
  cl.cleanup();

  return {
    name: 'Simple String Echo',
    results: [stResult, stAutoResult, clResult],
  };
}

// ============================================================
// Benchmark: Multiple arguments
// ============================================================

async function benchMultipleArgs(): Promise<BenchmarkSuite> {
  const iterations = 10000;

  const service = {
    add(a: number, b: number, c: number, d: number): number {
      return a + b + c + d;
    },
  };

  const st = setupSupertalk(service);
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const cl = setupComlink(service);

  const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
    'multiple-args',
    iterations,
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await st.remote.add(1, 2, 3, 4);
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await stAuto.remote.add(1, 2, 3, 4);
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await cl.remote.add(1, 2, 3, 4);
      }
    },
  );

  st.cleanup();
  stAuto.cleanup();
  cl.cleanup();

  return {
    name: 'Multiple Arguments (4 numbers)',
    results: [stResult, stAutoResult, clResult],
  };
}

// ============================================================
// Benchmark: Large payload (object)
// ============================================================

async function benchLargeObject(): Promise<BenchmarkSuite> {
  const iterations = 1000;

  // Create a large object with various data types
  const largeObject = {
    id: 12345,
    name: 'Test Object',
    description: 'A'.repeat(1000),
    tags: Array.from({length: 100}, (_, i) => `tag-${String(i)}`),
    metadata: Object.fromEntries(
      Array.from({length: 50}, (_, i) => [
        `key${String(i)}`,
        `value${String(i)}`,
      ]),
    ),
    nested: {
      level1: {
        level2: {
          level3: {
            data: Array.from({length: 100}, (_, i) => i),
          },
        },
      },
    },
  };

  const service = {
    process(obj: typeof largeObject): typeof largeObject {
      return obj;
    },
  };

  const st = setupSupertalk(service);
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const cl = setupComlink(service);

  const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
    'large-object',
    iterations,
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await st.remote.process(largeObject);
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await stAuto.remote.process(largeObject);
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await cl.remote.process(largeObject);
      }
    },
  );

  st.cleanup();
  stAuto.cleanup();
  cl.cleanup();

  return {
    name: 'Large Object (~10KB payload)',
    results: [stResult, stAutoResult, clResult],
  };
}

// ============================================================
// Benchmark: Large array
// ============================================================

async function benchLargeArray(): Promise<BenchmarkSuite> {
  const iterations = 100; // Fewer iterations - large array is slow

  const largeArray = Array.from({length: 10000}, (_, i) => ({
    id: i,
    value: `item-${String(i)}`,
  }));

  const service = {
    process(arr: typeof largeArray): number {
      return arr.length;
    },
  };

  const st = setupSupertalk(service);
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const cl = setupComlink(service);

  const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
    'large-array',
    iterations,
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await st.remote.process(largeArray);
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await stAuto.remote.process(largeArray);
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await cl.remote.process(largeArray);
      }
    },
  );

  st.cleanup();
  stAuto.cleanup();
  cl.cleanup();

  return {
    name: 'Large Array (10,000 items)',
    results: [stResult, stAutoResult, clResult],
  };
}

// ============================================================
// Benchmark: Binary data (ArrayBuffer)
// TODO: Re-enable once ArrayBuffer is cloned instead of proxied.
// Currently supertalk proxies ArrayBuffer (since it's not a "plain object"),
// which makes this benchmark measure proxy overhead vs clone overhead.
// See ROADMAP.md "Known Issues" for details.
// ============================================================

// async function benchBinaryData(): Promise<BenchmarkSuite> {
//   const iterations = 1000;
//   const bufferSize = 1024 * 1024; // 1MB
//
//   const service = {
//     processBuffer(buffer: ArrayBuffer): number {
//       return buffer.byteLength;
//     },
//   };
//
//   const st = setupSupertalk(service);
//   const stAuto = setupSupertalk(service, {autoProxy: true});
//   const cl = setupComlink(service);
//
//   const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
//     'binary-data',
//     iterations,
//     async () => {
//       for (let j = 0; j < CALLS_PER_ITERATION; j++) {
//         const buffer = new ArrayBuffer(bufferSize);
//         await st.remote.processBuffer(buffer);
//       }
//     },
//     async () => {
//       for (let j = 0; j < CALLS_PER_ITERATION; j++) {
//         const buffer = new ArrayBuffer(bufferSize);
//         await stAuto.remote.processBuffer(buffer);
//       }
//     },
//     async () => {
//       for (let j = 0; j < CALLS_PER_ITERATION; j++) {
//         const buffer = new ArrayBuffer(bufferSize);
//         await cl.remote.processBuffer(buffer);
//       }
//     },
//   );
//
//   st.cleanup();
//   stAuto.cleanup();
//   cl.cleanup();
//
//   return {
//     name: 'Binary Data (1MB ArrayBuffer)',
//     results: [stResult, stAutoResult, clResult],
//   };
// }

// ============================================================
// Benchmark: Callback (proxy function)
// ============================================================

async function benchCallback(): Promise<BenchmarkSuite> {
  const iterations = 5000;

  const service = {
    callCallback(fn: () => string): string {
      return fn();
    },
  };

  const st = setupSupertalk(service);
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const cl = setupComlink(service);

  const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
    'callback',
    iterations,
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await st.remote.callCallback(() => 'result');
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await stAuto.remote.callCallback(() => 'result');
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await cl.remote.callCallback(Comlink.proxy(() => 'result'));
      }
    },
  );

  st.cleanup();
  stAuto.cleanup();
  cl.cleanup();

  return {
    name: 'Callback (proxy function)',
    results: [stResult, stAutoResult, clResult],
  };
}

// ============================================================
// Benchmark: Multiple callbacks in one call
// ============================================================

async function benchMultipleCallbacks(): Promise<BenchmarkSuite> {
  const iterations = 2000;

  const service = {
    processWith(
      onStart: () => void,
      onProgress: (n: number) => void,
      onEnd: () => string,
    ): string {
      onStart();
      onProgress(50);
      onProgress(100);
      return onEnd();
    },
  };

  const st = setupSupertalk(service);
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const cl = setupComlink(service);

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- benchmark callbacks
  const noop = (): void => {};

  const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
    'multiple-callbacks',
    iterations,
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await st.remote.processWith(noop, noop, () => 'done');
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await stAuto.remote.processWith(noop, noop, () => 'done');
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        await cl.remote.processWith(
          Comlink.proxy(noop),
          Comlink.proxy(noop),
          Comlink.proxy(() => 'done'),
        );
      }
    },
  );

  st.cleanup();
  stAuto.cleanup();
  cl.cleanup();

  return {
    name: 'Multiple Callbacks (3 proxy functions)',
    results: [stResult, stAutoResult, clResult],
  };
}

// ============================================================
// Benchmark: Rapid sequential calls
// ============================================================

async function benchRapidCalls(): Promise<BenchmarkSuite> {
  // This benchmark tests many rapid sequential calls
  // Uses higher calls-per-iteration to stress sequential throughput
  const iterations = 500;
  const rapidCallsPerIteration = 20;

  const service = {
    ping(): string {
      return 'pong';
    },
  };

  const st = setupSupertalk(service);
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const cl = setupComlink(service);

  // Note: This benchmark manually handles its own calls-per-iteration
  // so we use runTripleBenchmark with a custom multiplier
  const [stResult, stAutoResult, clResult] = await runTripleBenchmark(
    'rapid-calls',
    iterations,
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        for (let k = 0; k < rapidCallsPerIteration; k++) {
          await st.remote.ping();
        }
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        for (let k = 0; k < rapidCallsPerIteration; k++) {
          await stAuto.remote.ping();
        }
      }
    },
    async () => {
      for (let j = 0; j < CALLS_PER_ITERATION; j++) {
        for (let k = 0; k < rapidCallsPerIteration; k++) {
          await cl.remote.ping();
        }
      }
    },
  );

  st.cleanup();
  stAuto.cleanup();
  cl.cleanup();

  // Adjust the ops/sec to reflect actual calls (20 per inner iteration)
  const adjustedSt = {
    ...stResult,
    opsPerSec: stResult.opsPerSec * rapidCallsPerIteration,
  };
  const adjustedAuto = {
    ...stAutoResult,
    opsPerSec: stAutoResult.opsPerSec * rapidCallsPerIteration,
  };
  const adjustedCl = {
    ...clResult,
    opsPerSec: clResult.opsPerSec * rapidCallsPerIteration,
  };

  return {
    name: `Rapid Sequential Calls (${String(rapidCallsPerIteration)}x burst)`,
    results: [adjustedSt, adjustedAuto, adjustedCl],
  };
}

// ============================================================
// Benchmark: AutoProxy with nested callbacks (supertalk-only feature)
// ============================================================

async function benchAutoProxyNested(): Promise<BenchmarkSuite> {
  const iterations = 2000;

  const service = {
    processConfig(config: {
      name: string;
      handlers: {
        onData: (data: string) => void;
        onError: (err: string) => void;
      };
    }): string {
      config.handlers.onData('test-data');
      return config.name;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- benchmark callbacks
  const noop = (): void => {};

  // Supertalk - auto-proxy mode (nested callbacks work)
  const stAuto = setupSupertalk(service, {autoProxy: true});
  const autoResult = await runBenchmark(
    'auto-proxy-nested',
    'supertalk-autoproxy',
    iterations,
    async () => {
      await stAuto.remote.processConfig({
        name: 'test',
        handlers: {
          onData: noop,
          onError: noop,
        },
      });
    },
  );
  stAuto.cleanup();

  // Note: Comlink cannot do this without manual Comlink.proxy() wrapping
  // of every nested function, which is impractical for nested structures

  return {
    name: 'Nested Callbacks (autoProxy only)',
    results: [autoResult],
  };
}

// ============================================================
// Main
// ============================================================

// Map of benchmark names to functions
const benchmarks: Record<string, () => Promise<BenchmarkSuite>> = {
  string: benchSimpleString,
  args: benchMultipleArgs,
  object: benchLargeObject,
  array: benchLargeArray,
  // binary: benchBinaryData, // TODO: re-enable once ArrayBuffer is cloned
  callback: benchCallback,
  callbacks: benchMultipleCallbacks,
  rapid: benchRapidCalls,
  nested: benchAutoProxyNested,
};

async function main(): Promise<void> {
  const filter = process.argv[2];

  if (filter === '--help' || filter === '-h') {
    console.log('Usage: node benchmark.js [benchmark-name]');
    console.log('\nAvailable benchmarks:');
    for (const name of Object.keys(benchmarks)) {
      console.log(`  ${name}`);
    }
    console.log('\nRun without arguments to run all benchmarks.');
    process.exit(0);
  }

  if (filter && !benchmarks[filter]) {
    console.error(`Unknown benchmark: ${filter}`);
    console.error(`Available: ${Object.keys(benchmarks).join(', ')}`);
    process.exit(1);
  }

  console.log('🚀 Supertalk vs Comlink Benchmark Suite\n');
  console.log('='.repeat(80));

  const suites: Array<BenchmarkSuite> = [];

  if (filter) {
    // Run single benchmark
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked above
    suites.push(await benchmarks[filter]!());
  } else {
    // Run all benchmarks
    for (const fn of Object.values(benchmarks)) {
      suites.push(await fn());
    }
  }

  for (const suite of suites) {
    printSuite(suite);
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ Benchmark complete');

  // Summary table
  console.log('\n📋 Summary (ops/sec - higher is better):\n');
  console.log(
    'Benchmark'.padEnd(35) +
      'supertalk'.padStart(12) +
      'st+auto'.padStart(12) +
      'comlink'.padStart(12) +
      'st/cl'.padStart(8) +
      'auto/st'.padStart(8),
  );
  console.log('-'.repeat(87));

  for (const suite of suites) {
    const st = suite.results.find((r) => r.library === 'supertalk');
    const stAuto = suite.results.find(
      (r) => r.library === 'supertalk-autoproxy',
    );
    const cl = suite.results.find((r) => r.library === 'comlink');

    const stOps = st ? formatNumber(st.opsPerSec) : '-';
    const stAutoOps = stAuto ? formatNumber(stAuto.opsPerSec) : '-';
    const clOps = cl ? formatNumber(cl.opsPerSec) : '-';
    const stClRatio =
      st && cl ? `${formatNumber(st.opsPerSec / cl.opsPerSec)}x` : '-';
    const stAutoRatio =
      st && stAuto ? `${formatNumber(stAuto.opsPerSec / st.opsPerSec)}x` : '-';

    console.log(
      suite.name.substring(0, 35).padEnd(35) +
        stOps.padStart(12) +
        stAutoOps.padStart(12) +
        clOps.padStart(12) +
        stClRatio.padStart(8) +
        stAutoRatio.padStart(8),
    );
  }

  // Force exit - MessageChannels can keep the process alive
  process.exit(0);
}

main().catch(console.error);
