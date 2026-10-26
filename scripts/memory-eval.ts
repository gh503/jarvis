import { readFile } from 'node:fs/promises'
import { runMemoryEval, type MemoryEvalCase } from '../src/memory/eval.ts'

const file = process.argv[2] ?? new URL('../eval/memory-cases.json', import.meta.url).pathname
const cases = JSON.parse(await readFile(file, 'utf8')) as MemoryEvalCase[]
const report = await runMemoryEval(cases)
console.log(JSON.stringify(report, null, 2))
if (report.passed !== report.total || report.privacyLeaks > 0) process.exitCode = 1
