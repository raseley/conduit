/**
 * Steam login window.
 *
 * A dedicated, isolated `BrowserWindow` that hosts Facepunch's official Steam
 * login page and captures the returned auth token. Security requirements
 * are: `nodeIntegration: false`, `contextIsolation: true`, and NO
 * Conduit preload on this window — Facepunch owns the page content; Conduit owns
 * only the window frame. Nothing is injected into the page.
 *
 * ## How the token is captured
 * Since Facepunch's October 2026 change the login ends the way it does for the
 * official app: `fcm`'s `FACEPUNCH_LOGIN_URL` opens `/login` with the return
 * chain `/app?returnUrl=rust-plus://rust-auth-session`, and after Steam sign-in
 * Facepunch's `/app` endpoint answers
 * `302 Location: rust-plus://rust-auth-session?token=…&steamId=…`.
 *
 * We read that `Location` header in the window's own session
 * (`webRequest.onHeadersReceived`) and cancel the response, so the redirect is
 * never followed: the OS never sees the `rust-plus://` URL (which would launch an
 * installed Rust+ desktop app).
 *
 * `/app` answers "Login Failed" instead of redirecting when the request's
 * User-Agent names Windows — every Electron window on Windows. So, on the `/app`
 * request only, we send a Chrome-on-Linux User-Agent and platform hint.
 *
 * The window runs in its own in-memory session partition, so these request hooks
 * touch no other window, and no Steam cookie outlives the app.
 *
 * The captured token is handed to `fcm.submitSteamToken(...)` by the caller via
 * the `onToken` callback, then the window closes. We never persist or log the
 * token here.
 */

import { BrowserWindow } from "electron";

import { APP_ICON_PATH } from "../asset-paths.js";
import { FACEPUNCH_LOGIN_HOST } from "../constants.js";
import type { SteamWindowFailure } from "../steam-sign-in.js";

/** In-memory (no `persist:` prefix) session partition for the login window. */
const STEAM_LOGIN_PARTITION = "conduit-steam-login";

/** URL filter for Facepunch's `/app` step (also matches `/app.js` etc.; see {@link isAppStep}). */
const APP_STEP_FILTER = { urls: [`https://${FACEPUNCH_LOGIN_HOST}/app*`] };

/** Every Facepunch response: the final redirect is captured whichever page issues it. */
const FACEPUNCH_FILTER = { urls: [`https://${FACEPUNCH_LOGIN_HOST}/*`] };

/** The Rust+ app's URL scheme. Any redirect to it ends the login; none is ever followed. */
const RUST_PLUS_SCHEME = "rust-plus:";

/** Options for {@link openSteamLoginWindow}. */
export interface SteamLoginOptions {
  /** The Facepunch login URL passed by `fcm.register`'s `onSteamLogin`. */
  url: string;
  /** Parent window to modal-attach to (the wizard). */
  parent?: BrowserWindow;
  /** Invoked once with the captured Steam auth token. */
  onToken: (token: string) => void;
  /** Invoked if the user closes the window without completing login. */
  onCancelled?: () => void;
  /**
   * Invoked once if the login ends without a token, with a typed failure:
   * `refused` for Facepunch's Login Failed page, `flow-changed` when Facepunch
   * answered in a way Conduit doesn't recognise (a redirect without a token,
   * `/app` answering with a page, or the window closed after `/app` redirected
   * somewhere unexpected). The reason is token-free and safe to log.
   */
  onFailed?: (failure: SteamWindowFailure) => void;
}

/** Open the isolated Steam login window. */
export function openSteamLoginWindow(opts: SteamLoginOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent: opts.parent,
    modal: Boolean(opts.parent),
    title: "Sign in with Steam — Conduit",
    icon: APP_ICON_PATH,
    backgroundColor: "#1E1F22", // bg-deepest
    autoHideMenuBar: true,
    webPreferences: {
      // Hard isolation: no Node, isolated context, NO Conduit preload.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: undefined,
      partition: STEAM_LOGIN_PARTITION,
    },
  });
  const { webRequest } = win.webContents.session;

  let settled = false;
  // Where Facepunch last redirected away from /app (origin + path only, never the
  // query): if the user then gives up, it is the clue the log needs.
  let lastAppRedirect: string | undefined;

  const detachHooks = (): void => {
    webRequest.onBeforeSendHeaders(APP_STEP_FILTER, null);
    webRequest.onHeadersReceived(FACEPUNCH_FILTER, null);
  };

  const finish = (outcome: SteamAuthOutcome): void => {
    if (settled) return;
    settled = true;
    detachHooks();
    if (outcome.kind === "token") opts.onToken(outcome.token);
    else opts.onFailed?.(outcome);
    if (!win.isDestroyed()) win.close();
  };

  const userAgent = appStepUserAgent(process.versions.chrome);
  webRequest.onBeforeSendHeaders(APP_STEP_FILTER, (details, callback) => {
    if (!isAppStep(details.url)) return callback({});
    callback({ requestHeaders: withAppStepHeaders(details.requestHeaders, userAgent) });
  });

  webRequest.onHeadersReceived(FACEPUNCH_FILTER, (details, callback) => {
    const verdict = judgeFacepunchResponse(
      details.url,
      details.statusCode,
      details.responseHeaders,
    );
    if (verdict.kind === "continue") {
      if (verdict.appRedirectTo) lastAppRedirect = verdict.appRedirectTo;
      return callback({});
    }
    // Never let the browser follow (or render) the final step: either we have
    // what we came for, or the login has failed and the window is closing. A
    // followed rust-plus:// redirect would launch an installed Rust+ app.
    callback({ cancel: true });
    finish(verdict);
  });

  // Facepunch's own failure page, e.g. when Steam sign-in is cancelled.
  win.webContents.on("did-navigate", (_e, target) => {
    const reason = loginFailedReason(target);
    if (reason !== undefined) finish({ kind: "refused", reason });
  });

  // Belt and braces: should the redirect ever reach navigation, catch it there.
  const interceptAuthRedirect = (e: Electron.Event, target: string): void => {
    const outcome = parseAuthRedirect(target);
    if (!outcome) return;
    e.preventDefault();
    finish(outcome);
  };
  win.webContents.on("will-navigate", interceptAuthRedirect);
  win.webContents.on("will-redirect", interceptAuthRedirect);

  win.on("closed", () => {
    if (settled) return;
    settled = true;
    detachHooks();
    // Closed mid-flow after /app sent us elsewhere: report where, so a login
    // that stalls on some Facepunch page is diagnosable from the log.
    if (lastAppRedirect) {
      opts.onFailed?.({
        kind: "flow-changed",
        reason: `window closed after /app redirected to ${lastAppRedirect}`,
      });
    } else {
      opts.onCancelled?.();
    }
  });

  void win.loadURL(opts.url);
  return win;
}

// ── Pure helpers (unit-tested in steam-window.test.ts) ─────────────────────────

/**
 * How a login ended: with a token, or with a typed, token-free failure
 * (`refused` by Facepunch's Login Failed page, or `flow-changed`).
 */
export type SteamAuthOutcome = { kind: "token"; token: string } | SteamWindowFailure;

/** Read a query parameter case-insensitively (Facepunch has used `Token` and `token`). */
function queryParam(params: URLSearchParams, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of params) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
}

/**
 * Parse Facepunch's final `rust-plus://rust-auth-session?token=…&steamId=…`
 * redirect. Any `rust-plus:` URL ends the login (it must never be followed);
 * anything else returns `undefined`. An `error` parameter, a missing token, or an
 * unparseable URL is a failure.
 */
export function parseAuthRedirect(location: string): SteamAuthOutcome | undefined {
  if (!location.toLowerCase().startsWith(RUST_PLUS_SCHEME)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return { kind: "flow-changed", reason: "unreadable rust-plus redirect" };
  }
  const token = queryParam(parsed.searchParams, "token")?.trim();
  if (token) return { kind: "token", token };
  return {
    kind: "flow-changed",
    reason: `redirect without token (${queryParam(parsed.searchParams, "error") ?? "no error given"})`,
  };
}

/**
 * A redirect target safe to log: origin + path of the (possibly relative)
 * `Location`, resolved against the Facepunch host. Query and fragment are
 * dropped, since they can carry tokens.
 */
export function redirectTargetForLog(location: string): string {
  try {
    const url = new URL(location, `https://${FACEPUNCH_LOGIN_HOST}`);
    return url.protocol === "http:" || url.protocol === "https:"
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}…`;
  } catch {
    return "(unparseable)";
  }
}

/** Whether a request URL is Facepunch's `/app` endpoint itself (not `/app.js`, `/apple-…`). */
export function isAppStep(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === FACEPUNCH_LOGIN_HOST &&
      (parsed.pathname === "/app" || parsed.pathname === "/app/")
    );
  } catch {
    return false;
  }
}

/** If `url` is Facepunch's Login Failed page, its `reason` (or `"unknown"`); else `undefined`. */
export function loginFailedReason(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== FACEPUNCH_LOGIN_HOST) return undefined;
  if (!parsed.pathname.startsWith("/login-failed")) return undefined;
  return queryParam(parsed.searchParams, "reason") ?? "unknown";
}

/**
 * A plain Chrome-on-Linux User-Agent for the `/app` request. Facepunch's `/app`
 * answers "Login Failed" when the User-Agent names Windows.
 */
export function appStepUserAgent(chromeVersion: string): string {
  return (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${chromeVersion} Safari/537.36`
  );
}

/**
 * The `/app` request's headers with the User-Agent replaced and, if the browser
 * sent one, the `Sec-CH-UA-Platform` hint set to match. Header names are matched
 * case-insensitively; every other header is kept as sent.
 */
export function withAppStepHeaders(
  headers: Record<string, string>,
  userAgent: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "user-agent") continue;
    out[name] = lower === "sec-ch-ua-platform" ? '"Linux"' : value;
  }
  out["User-Agent"] = userAgent;
  return out;
}

/**
 * Verdict on one Facepunch response: the login ended (with a token or a
 * failure), or it carries on. `appRedirectTo` is set when `/app` itself
 * redirected somewhere other than the Rust+ app (a log-safe target).
 */
export type FacepunchVerdict = SteamAuthOutcome | { kind: "continue"; appRedirectTo?: string };

/**
 * Judge a Facepunch response the way the reference client (HandyS11/RustPlusApi,
 * `RustPlusAppLogin.HandleResponseAsync`) does:
 * - a redirect to `rust-plus:`, from any path, ends the login and is never followed;
 * - any other redirect is followed and not judged — `/app` can hop before its
 *   final answer;
 * - a non-redirect answer from `/app` itself is a refusal (typically its
 *   "Login Failed" page, served to Windows user agents);
 * - everything else carries on.
 */
export function judgeFacepunchResponse(
  url: string,
  statusCode: number,
  responseHeaders: Record<string, string[]> | undefined,
): FacepunchVerdict {
  const appStep = isAppStep(url);
  if (statusCode >= 300 && statusCode < 400) {
    const location = Object.entries(responseHeaders ?? {}).find(
      ([name]) => name.toLowerCase() === "location",
    )?.[1]?.[0];
    if (location === undefined) return { kind: "continue" };
    const outcome = parseAuthRedirect(location);
    if (outcome) return outcome;
    return appStep
      ? { kind: "continue", appRedirectTo: redirectTargetForLog(location) }
      : { kind: "continue" };
  }
  if (!appStep) return { kind: "continue" };
  return {
    kind: "flow-changed",
    reason: `/app answered HTTP ${statusCode} instead of the sign-in redirect`,
  };
}
