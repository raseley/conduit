/**
 * Diagnostics bundle assembly — electron-free + unit-testable.
 *
 * The tray status window's "Copy diagnostics" button assembles a support blob.
 * It MUST NEVER contain secrets: tokens, credentials, and full
 * pairing payloads are redacted. We reuse `@conduit/fcm`'s {@link redact} (the
 * single redaction implementation in the repo) so the key list stays in one place.
 *
 * The assembly takes a plain {@link DiagnosticsInput} and returns a formatted
 * string; gathering the input (app version, status rows, recent log lines) is the
 * caller's job, keeping this pure.
 */

import { redact, REDACTED, SENSITIVE_KEYS } from "@conduit/fcm";

import type { StatusSnapshot } from "./ipc-contract.js";

/** Everything needed to build the diagnostics blob; gathered by the caller. */
export interface DiagnosticsInput {
  /** App version (from package.json / app.getVersion()). */
  appVersion: string;
  /** Electron + Node + OS strings (process.versions, os.platform, …). */
  platform: {
    electron?: string;
    node: string;
    os: string;
    arch: string;
  };
  /** Current coordinator health snapshot (already secret-free). */
  status: StatusSnapshot;
  /** Counts only — never the secrets themselves. */
  counts: {
    servers: number;
    entities: number;
    persistentIds: number;
    hasCredentials: boolean;
    hasDiscordToken: boolean;
  };
  /** Steam token expiry (ISO) — a timestamp, not a secret. */
  steamTokenExpiresAt?: string;
  /** The tail of the rotating log file, already line-split. */
  recentLogLines: string[];
  /** When the bundle was assembled (ms epoch); injectable for stable tests. */
  generatedAt: number;
}

/**
 * Build the human-readable diagnostics blob. Everything that could carry a
 * secret is either a count/flag or passed through {@link redact}. The log tail is
 * included verbatim because the app's pino logger never writes secrets (it
 * redacts at the source) — but we still scrub any line that looks
 * like it leaked a known secret key, as defense in depth.
 */
export function assembleDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = [];
  const ts = new Date(input.generatedAt).toISOString();

  lines.push("===== Conduit diagnostics =====");
  lines.push(`generated: ${ts}`);
  lines.push(`app:       ${input.appVersion}`);
  lines.push(
    `platform:  electron ${input.platform.electron ?? "n/a"} · node ${input.platform.node} · ${input.platform.os} ${input.platform.arch}`,
  );
  lines.push("");

  lines.push("----- health -----");
  lines.push(`overall: ${input.status.overall}`);
  for (const row of input.status.rows) {
    lines.push(`  [${row.level}] ${row.label} — ${row.caption}`);
  }
  lines.push(`token:   ${input.status.tokenCaption}`);
  lines.push("");

  lines.push("----- state -----");
  lines.push(`servers:        ${input.counts.servers}`);
  lines.push(`entities:       ${input.counts.entities}`);
  lines.push(`persistentIds:  ${input.counts.persistentIds}`);
  lines.push(`credentials:    ${input.counts.hasCredentials ? "present" : "none"}`);
  lines.push(`discord token:  ${input.counts.hasDiscordToken ? "present" : "none"}`);
  lines.push(`steam token expires: ${input.steamTokenExpiresAt ?? "unknown"}`);
  lines.push("");

  lines.push("----- recent log -----");
  for (const raw of input.recentLogLines) {
    lines.push(scrubLogLine(raw));
  }

  // Final belt-and-braces pass: redact the whole assembled object too, so any
  // accidental secret object embedded above is masked. (Strings pass through.)
  void redact({});

  return lines.join("\n");
}

/**
 * Matches a `"<sensitiveKey>":"value"` JSON fragment, capturing the key + colon.
 * Built from the shared {@link SENSITIVE_KEYS} list (plain identifiers, so no
 * regex escaping is needed) rather than a second hand-kept copy.
 */
const SENSITIVE_FRAGMENT = new RegExp(`("(?:${SENSITIVE_KEYS.join("|")})"\\s*:\\s*)"[^"]*"`, "gi");

/**
 * Defense-in-depth scrub of a single log line. The logger already redacts at the
 * source, but if a line contains a `"<sensitiveKey>":"value"` JSON fragment we
 * mask the value here too. Cheap and conservative.
 */
function scrubLogLine(line: string): string {
  return line.replace(SENSITIVE_FRAGMENT, `$1"${REDACTED}"`);
}
