#!/usr/bin/env node
/**
 * Exit 0 once the in-progress turn of a dsh session has ended.
 *
 * `restart-and-verify.sh` uses this to detach the service restart from the
 * agent's final answer: the answer is durable once `turn/end` lands, so the
 * restart may fire immediately afterwards instead of guessing a grace period
 * (and risking a kill mid-answer). Falls back to the caller's fixed delay when
 * the session cannot be watched (no in-progress turn, unreadable file, timeout).
 *
 * Usage: turn-end-wait.mjs <session.v4.jsonl.zstd> [timeoutSeconds]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, timeoutArg] = process.argv.slice(2)
if (!file) {
  console.error('turn-end-wait: usage: turn-end-wait.mjs <session.v4.jsonl.zstd> [timeoutSeconds]')
  process.exit(2)
}
const timeoutMs = Math.max(10, Number(timeoutArg ?? 1800)) * 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Decompress and parse the durable event log; throws while a write is torn. */
function readEvents() {
  const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn trailing line during an append: ignore, the next poll re-reads.
    }
  }
  return events
}

let initial
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    initial = readEvents()
    break
  } catch {
    await sleep(250)
  }
}
if (initial === undefined) {
  console.error('turn-end-wait: cannot read session file')
  process.exit(1)
}
const last = initial[initial.length - 1]
if (last?.type === 'turn/end') {
  console.error('turn-end-wait: no turn in progress')
  process.exit(1)
}
let turn = 0
for (const event of initial) {
  if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = Math.max(turn, event.data.turn)
}
if (turn === 0) {
  console.error('turn-end-wait: no turn/start event')
  process.exit(1)
}

const deadline = Date.now() + timeoutMs
while (Date.now() < deadline) {
  await sleep(2000)
  let events
  try {
    events = readEvents()
  } catch {
    continue
  }
  for (const event of events) {
    if (event.type === 'turn/end' && Number.isSafeInteger(event.data?.turn) && event.data.turn >= turn) {
      // Let the harness finish the tiny post-turn bookkeeping before SIGTERM.
      await sleep(3000)
      process.exit(0)
    }
  }
}
console.error('turn-end-wait: timed out waiting for turn/end')
process.exit(1)
