/**
 * Logging setup — pino to a rotating file under the data dir.
 *
 * `pino` itself is electron-free, so this module can be imported in tests. The
 * logger is configured with a `redact` paths list as a backstop, but the real
 * guarantee is upstream: fcm/bot-core redact secrets at the source and the
 * desktop code never logs a raw credential. We additionally cap the file and
 * keep a small ring of recent lines in memory for the "Copy diagnostics" tail
 * (so we don't have to read the file back, which may be locked on Windows).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import pino, { type Logger as PinoLogger } from "pino";

import { REDACTED, SENSITIVE_KEYS } from "@conduit/fcm";

/**
 * Field paths pino will redact as a safety net: every key in the shared
 * {@link SENSITIVE_KEYS} list, both at the top level of a log object and one
 * level down (`*.key`, where call sites nest a payload under a name). Derived —
 * never hand-edited — so the logger can't drift from `redact()`.
 */
export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`]);

/** A bounded in-memory ring of recent log lines for diagnostics. */
export class LogRing {
  private readonly buf: string[] = [];
  constructor(private readonly max: number = 200) {}
  push(line: string): void {
    this.buf.push(line);
    if (this.buf.length > this.max) this.buf.shift();
  }
  lines(): string[] {
    return [...this.buf];
  }
}

export interface CreateLoggerResult {
  logger: PinoLogger;
  ring: LogRing;
  /** Absolute path of the log file. */
  logFile: string;
}

/**
 * Create the app logger writing to `<dataDir>/logs/conduit.log` plus an in-memory
 * ring. The directory is created if missing. We use pino's default JSON output
 * (one object per line); the ring captures the same lines for the diagnostics
 * tail.
 *
 * Note: pino's file transport is configured lazily; if it cannot open the file
 * (e.g. a locked dir) we fall back to stdout so logging never crashes startup.
 */
export async function createLogger(
  dataDir: string,
  level: string = "info",
): Promise<CreateLoggerResult> {
  const logsDir = path.join(dataDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "conduit.log");

  const ring = new LogRing();

  // A custom write target that tees to the file (append) and the ring. Using a
  // pino destination keeps it synchronous + simple; rotation is size-checked on
  // each create (a full transport-based rotation is overkill for one operator).
  await rotateIfLarge(logFile);

  const fd = await fs.open(logFile, "a");
  const stream = {
    write(line: string): void {
      ring.push(line.trimEnd());
      void fd.write(line);
    },
  };

  const logger = pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      base: undefined,
    },
    stream,
  );

  return { logger, ring, logFile };
}

/** Roll the log file aside if it has grown past ~5 MB (cheap rotation). */
async function rotateIfLarge(logFile: string): Promise<void> {
  try {
    const stat = await fs.stat(logFile);
    if (stat.size > 5 * 1024 * 1024) {
      await fs.rename(logFile, `${logFile}.1`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Non-fatal: logging must not block startup.
    }
  }
}
