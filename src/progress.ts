/**
 * Deno-style download progress display.
 *
 * Uses raw ANSI escape codes for color because `styleText` from node:util
 * checks `process.stderr.hasColors()` which returns false in the loader
 * worker thread — even though fd 2 is a real TTY (verified via tty.isatty).
 *
 * Writes directly to fd 2 so it works from both the main thread
 * and the loader worker thread.
 */

import process from "node:process";
import { writeSync } from "node:fs";
import { isatty, WriteStream } from "node:tty";

const BAR_WIDTH = 10;
const SNAKE_LEN = 3;
const TICK_INTERVAL = 80;

/**
 * File descriptor for stderr.
 * In the loader worker thread (spawned by module.register()), process.stderr
 * is not a real WriteStream so `.fd` is undefined — but the underlying fd 2
 * is still inherited from the parent process and works with writeSync/isatty.
 */
const STDERR_FD: number = process.stderr.fd ?? 2;

// ── ANSI helpers ────────────────────────────────────────────────

/**
 * Respect the NO_COLOR convention (https://no-color.org/) and
 * NODE_DISABLE_COLORS, same as styleText() from node:util.
 */
const useColor: boolean =
  !("NO_COLOR" in process.env) && !("NODE_DISABLE_COLORS" in process.env);

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function color(code: string, text: string): string {
  return isTTY && useColor ? `${code}${text}${RESET}` : text;
}

// ── State ───────────────────────────────────────────────────────

interface ProgressState {
  total: number;
  done: number;
  currentUrl: string;
  startTime: number;
  active: boolean;
  tick: number;
  timer: ReturnType<typeof setInterval> | null;
}

const state: ProgressState = {
  total: 0,
  done: 0,
  currentUrl: "",
  startTime: 0,
  active: false,
  tick: 0,
  timer: null,
};

const isTTY: boolean = isatty(STDERR_FD);

let stderrStream: { write(str: string): void };
if (process.stderr.fd !== undefined) {
  stderrStream = process.stderr;
} else if (isTTY) {
  try {
    // In the loader worker thread on Windows, writeSync(2, utf8_string) prints mojibake.
    // Creating a real WriteStream invokes uv_tty_init which properly handles Windows console APIs.
    stderrStream = new WriteStream(STDERR_FD);
  } catch {
    stderrStream = { write: (str) => writeSync(STDERR_FD, str) };
  }
} else {
  stderrStream = { write: (str) => writeSync(STDERR_FD, str) };
}

function writeStderr(str: string): void {
  stderrStream.write(str);
}

// ── Formatting ──────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `[${min}:${sec}]`;
}

function progressBar(done: number, total: number, tick: number): string {
  const filled =
    total > 0 ? Math.min(Math.round((done / total) * BAR_WIDTH), BAR_WIDTH) : 0;
  const empty = BAR_WIDTH - filled;

  if (empty === 0) {
    return "█".repeat(BAR_WIDTH);
  }

  const head = tick % empty;

  const chars: string[] = [];
  for (let i = 0; i < BAR_WIDTH; i++) {
    if (i < filled) {
      chars.push("█");
    } else {
      const ei = i - filled;
      const dist = (ei - head + empty) % empty;
      const inSnake = dist === 0 || dist > empty - SNAKE_LEN;
      chars.push(inSnake ? "▓" : "░");
    }
  }
  return chars.join("");
}

// ── Rendering ───────────────────────────────────────────────────

function render(): void {
  if (!isTTY) return;

  const elapsed = formatElapsed(Date.now() - state.startTime);
  const bar = progressBar(state.done, state.total, state.tick);
  const counter = `${state.done}/${state.total}`;

  const line1 = `${color(GREEN, "Download")} ${color(CYAN, bar)} ${color(DIM, elapsed)} ${color(YELLOW, counter)}`;
  const line2 = `  ${color(DIM, state.currentUrl)}`;

  if (state.active) {
    writeStderr("\x1b[2A\x1b[0J");
  }
  writeStderr(line1 + "\n" + line2 + "\n");
  state.active = true;
}

function startTimer(): void {
  if (state.timer || !isTTY) return;
  state.timer = setInterval(() => {
    state.tick++;
    render();
  }, TICK_INTERVAL);
  state.timer.unref();
}

function stopTimer(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// ── Public API ──────────────────────────────────────────────────

export function downloadStart(total = 0): void {
  state.total = total;
  state.done = 0;
  state.tick = 0;
  state.startTime = Date.now();
  state.active = false;
  startTimer();
}

export function downloadAdd(): void {
  state.total++;
}

export function downloadBegin(url: string): void {
  state.currentUrl = url;
  render();
}

export function downloadDone(): void {
  state.done++;
  if (state.done >= state.total) {
    downloadEnd();
  } else {
    render();
  }
}

export function downloadEnd(): void {
  stopTimer();
  if (!isTTY || !state.active) return;
  writeStderr("\x1b[2A\x1b[0J");
  state.active = false;
}
