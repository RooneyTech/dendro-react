/**
 * Parser Performance Benchmark
 *
 * Compares Babel parser vs OXC parser performance.
 * Run with: npx ts-node src/test/benchmark/parser-benchmark.ts
 */

import { performance } from 'perf_hooks';
import * as path from 'path';
import * as fs from 'fs';

// Import both parsers
const babelParser = require('../../server/parser.js');
import * as oxcParser from '../../server/parser-oxc';

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

async function benchmark(
  name: string,
  fn: () => void,
  iterations: number = 100
): Promise<BenchmarkResult> {
  const times: number[] = [];

  // Warmup
  for (let i = 0; i < 5; i++) {
    fn();
  }

  // Actual benchmark
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  return {
    name,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
  };
}

function formatResult(result: BenchmarkResult): string {
  return `${result.name}:
  Iterations: ${result.iterations}
  Total: ${result.totalMs.toFixed(2)}ms
  Average: ${result.avgMs.toFixed(3)}ms
  Min: ${result.minMs.toFixed(3)}ms
  Max: ${result.maxMs.toFixed(3)}ms`;
}

async function main() {
  const fixturesDir = path.resolve(__dirname, '../fixtures/mcp-tools');
  const entryFile = 'App.tsx';

  console.log('='.repeat(60));
  console.log('Parser Performance Benchmark: Babel vs OXC');
  console.log('='.repeat(60));
  console.log(`\nFixtures directory: ${fixturesDir}`);
  console.log(`Entry file: ${entryFile}`);
  console.log();

  // Test 1: Full component tree parsing
  console.log('--- Test 1: buildComponentTree (full tree) ---\n');

  const babelTreeResult = await benchmark('Babel Parser', () => {
    babelParser.buildComponentTree(entryFile, fixturesDir);
  });

  const oxcTreeResult = await benchmark('OXC Parser', () => {
    oxcParser.buildComponentTree(entryFile, fixturesDir);
  });

  console.log(formatResult(babelTreeResult));
  console.log();
  console.log(formatResult(oxcTreeResult));
  console.log();

  const treeSpeedup = babelTreeResult.avgMs / oxcTreeResult.avgMs;
  console.log(`Speedup: ${treeSpeedup.toFixed(1)}x faster with OXC\n`);

  // Test 2: Single file parsing
  console.log('--- Test 2: parseFileToAST (single file) ---\n');

  const singleFile = path.join(fixturesDir, 'MainContent.tsx');

  const babelSingleResult = await benchmark('Babel Parser', () => {
    babelParser.parseFileToAST(singleFile);
  }, 500);

  const oxcSingleResult = await benchmark('OXC Parser', () => {
    oxcParser.parseFileToAST(singleFile);
  }, 500);

  console.log(formatResult(babelSingleResult));
  console.log();
  console.log(formatResult(oxcSingleResult));
  console.log();

  const singleSpeedup = babelSingleResult.avgMs / oxcSingleResult.avgMs;
  console.log(`Speedup: ${singleSpeedup.toFixed(1)}x faster with OXC\n`);

  // Test 3: Import detection
  console.log('--- Test 3: findImportsInAST ---\n');

  const babelAst = babelParser.parseFileToAST(singleFile);
  const oxcAst = oxcParser.parseFileToAST(singleFile);

  const babelImportsResult = await benchmark('Babel Parser', () => {
    babelParser.findImportsInAST(babelAst);
  }, 1000);

  const oxcImportsResult = await benchmark('OXC Parser', () => {
    oxcParser.findImportsInAST(oxcAst);
  }, 1000);

  console.log(formatResult(babelImportsResult));
  console.log();
  console.log(formatResult(oxcImportsResult));
  console.log();

  const importsSpeedup = babelImportsResult.avgMs / oxcImportsResult.avgMs;
  console.log(`Speedup: ${importsSpeedup.toFixed(1)}x faster with OXC\n`);

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`\nFull tree parsing:    ${treeSpeedup.toFixed(1)}x faster`);
  console.log(`Single file parsing:  ${singleSpeedup.toFixed(1)}x faster`);
  console.log(`Import detection:     ${importsSpeedup.toFixed(1)}x faster`);
  console.log(`\nAverage improvement:  ${((treeSpeedup + singleSpeedup + importsSpeedup) / 3).toFixed(1)}x faster`);
  console.log();
}

main().catch(console.error);
