#!/usr/bin/env ts-node --files -r tsconfig-paths/register
/**
 * export-golden-set.ts — exports stable-pass eval cases as a golden set for
 * regression testing. Reads the latest eval results, filters for cases that
 * passed deterministically, and writes a JSON golden set file.
 *
 * Usage:
 *   npx ts-node --files -r tsconfig-paths/register eval/export-golden-set.ts
 *   npx ts-node --files -r tsconfig-paths/register eval/export-golden-set.ts --compare <golden-set.json>
 *
 * The --compare flag diffs against an existing golden set and reports
 * regressions (cases that were passing but now fail) and improvements
 * (cases that were failing but now pass).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const RESULTS_DIR = path.join(__dirname, 'results');
const GOLDEN_SET_DIR = path.join(__dirname, 'golden-sets');

interface GoldenCase {
  corpus: string;
  question: string;
  expect: string;
  mustContain?: Array<string | string[]>;
  mustNotContain?: string[];
  note?: string;
  answer: string;
  confidence: number;
  latencyMs: number;
  timestamp: string;
  hash: string;
}

interface GoldenSet {
  version: 1;
  exportedAt: string;
  corpusCount: number;
  caseCount: number;
  cases: GoldenCase[];
}

interface DiffResult {
  regressions: Array<{ corpus: string; question: string; oldAnswer: string }>;
  improvements: Array<{ corpus: string; question: string; newAnswer: string }>;
  unchanged: number;
  newCases: number;
  removedCases: number;
}

function findLatestResults(): Map<string, string> {
  const resultDirs = fs.readdirSync(RESULTS_DIR).sort().reverse();
  const latestByCorpus = new Map<string, string>();

  for (const dir of resultDirs) {
    const turnsPath = path.join(RESULTS_DIR, dir, 'turns.jsonl');
    if (!fs.existsSync(turnsPath)) continue;

    const lines = fs.readFileSync(turnsPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      const record = JSON.parse(line);
      // Keep the latest (most recent directory) for each corpus
      if (!latestByCorpus.has(record.corpus)) {
        latestByCorpus.set(record.corpus, turnsPath);
      }
    }
  }

  return latestByCorpus;
}

function loadTurns(turnsPath: string): Map<string, any[]> {
  const lines = fs.readFileSync(turnsPath, 'utf-8').trim().split('\n');
  const byCorpus = new Map<string, any[]>();

  for (const line of lines) {
    const record = JSON.parse(line);
    const existing = byCorpus.get(record.corpus) ?? [];
    existing.push(record);
    byCorpus.set(record.corpus, existing);
  }

  return byCorpus;
}

function computeHash(answer: string): string {
  return crypto.createHash('sha256').update(answer).digest('hex').slice(0, 16);
}

function exportGoldenSet(): GoldenSet {
  const latestPaths = findLatestResults();

  if (latestPaths.size === 0) {
    console.error('No eval results found in', RESULTS_DIR);
    process.exit(1);
  }

  const allCases: GoldenCase[] = [];
  const seenKeys = new Set<string>();

  for (const [corpus, turnsPath] of latestPaths) {
    const turns = loadTurns(turnsPath);
    const corpusTurns = turns.get(corpus) ?? [];

    for (const turn of corpusTurns) {
      if (!turn.deterministicPass) continue;

      const key = `${corpus}::${turn.question}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      allCases.push({
        corpus,
        question: turn.question,
        expect: turn.expect,
        note: turn.note,
        answer: turn.answer,
        confidence: turn.confidence,
        latencyMs: turn.latencyMs,
        timestamp: turn.timestamp ?? new Date().toISOString(),
        hash: computeHash(turn.answer),
      });
    }
  }

  const goldenSet: GoldenSet = {
    version: 1,
    exportedAt: new Date().toISOString(),
    corpusCount: new Set(allCases.map((c) => c.corpus)).size,
    caseCount: allCases.length,
    cases: allCases.sort((a, b) => a.corpus.localeCompare(b.corpus) || a.question.localeCompare(b.question)),
  };

  return goldenSet;
}

function diffGoldenSets(oldSet: GoldenSet, newSet: GoldenSet): DiffResult {
  const oldMap = new Map(oldSet.cases.map((c) => [`${c.corpus}::${c.question}`, c]));
  const newMap = new Map(newSet.cases.map((c) => [`${c.corpus}::${c.question}`, c]));

  const regressions: DiffResult['regressions'] = [];
  const improvements: DiffResult['improvements'] = [];
  let unchanged = 0;

  for (const [key, oldCase] of oldMap) {
    const newCase = newMap.get(key);
    if (!newCase) {
      // Case was in old set but not in new — it regressed
      regressions.push({
        corpus: oldCase.corpus,
        question: oldCase.question,
        oldAnswer: oldCase.answer,
      });
    } else if (oldCase.hash !== newCase.hash) {
      // Answer changed — could be improvement or regression
      // Since we only export passing cases, a different hash means the answer changed
      // We consider it an improvement if the new answer is longer (more complete)
      if (newCase.answer.length > oldCase.answer.length) {
        improvements.push({
          corpus: newCase.corpus,
          question: newCase.question,
          newAnswer: newCase.answer,
        });
      } else {
        unchanged++;
      }
    } else {
      unchanged++;
    }
  }

  const newCases = [...newMap.keys()].filter((key) => !oldMap.has(key)).length;
  const removedCases = [...oldMap.keys()].filter((key) => !newMap.has(key)).length;

  return { regressions, improvements, unchanged, newCases, removedCases };
}

function main(): void {
  const args = process.argv.slice(2);
  const compareIndex = args.indexOf('--compare');
  const comparePath = compareIndex >= 0 ? args[compareIndex + 1] : null;

  console.log('Exporting golden set from latest eval results...');
  const goldenSet = exportGoldenSet();

  // Write golden set
  fs.mkdirSync(GOLDEN_SET_DIR, { recursive: true });
  const outputPath = path.join(GOLDEN_SET_DIR, `golden-set-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(goldenSet, null, 2));

  console.log(`\nGolden set exported:`);
  console.log(`  Corpora: ${goldenSet.corpusCount}`);
  console.log(`  Cases:   ${goldenSet.caseCount}`);
  console.log(`  Output:  ${outputPath}`);

  // Also write/update the "latest" symlink
  const latestPath = path.join(GOLDEN_SET_DIR, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(goldenSet, null, 2));
  console.log(`  Latest:  ${latestPath}`);

  // Compare if requested
  if (comparePath) {
    if (!fs.existsSync(comparePath)) {
      console.error(`\nComparison file not found: ${comparePath}`);
      process.exit(1);
    }

    const oldSet: GoldenSet = JSON.parse(fs.readFileSync(comparePath, 'utf-8'));
    const diff = diffGoldenSets(oldSet, goldenSet);

    console.log(`\n--- Diff against ${path.basename(comparePath)} ---`);
    console.log(`  Unchanged:    ${diff.unchanged}`);
    console.log(`  New cases:    ${diff.newCases}`);
    console.log(`  Removed:      ${diff.removedCases}`);
    console.log(`  Improvements: ${diff.improvements.length}`);

    if (diff.regressions.length > 0) {
      console.log(`\n  REGRESSIONS (${diff.regressions.length}):`);
      for (const reg of diff.regressions) {
        console.log(`    [${reg.corpus}] ${reg.question}`);
      }
    } else {
      console.log(`  Regressions:  0 ✓`);
    }

    if (diff.improvements.length > 0) {
      console.log(`\n  IMPROVEMENTS (${diff.improvements.length}):`);
      for (const imp of diff.improvements) {
        console.log(`    [${imp.corpus}] ${imp.question}`);
      }
    }
  }
}

main();
