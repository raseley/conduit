/**
 * Why a "Connect Steam" attempt failed, and what the wizard says about it.
 * Pure and electron-free, so the mapping is unit-tested without Electron.
 *
 * The Steam window (`windows/steam-window.ts`) knows how a login ended. It
 * reports that as a typed {@link SteamSignInFailure}; `main.ts` rejects
 * `fcm.register`'s `onSteamLogin` with a {@link SteamSignInError} carrying it, so
 * the failure survives fcm wrapping it in an `AuthError` as the `cause`.
 * {@link classifySteamConnectError} digs it back out (or infers the stage from
 * how far the attempt got) and {@link steamFailureCopy} turns it into wizard copy.
 *
 * Reasons are token-free (they come from the window's pure helpers, which drop
 * every URL query). The copy never includes a reason except a short, plain-word
 * Facepunch Login Failed reason such as `cancelled`.
 */

import type { SteamRenewalResult } from "./ipc-contract.js";
import type { WizardEvent } from "./wizard-machine.js";

/** How a Steam sign-in attempt failed. */
export type SteamSignInFailure =
  /** The user closed the sign-in window. Nothing went wrong. */
  | { kind: "cancelled" }
  /** Facepunch's Login Failed page, with its `reason` (e.g. `cancelled`). */
  | { kind: "refused"; reason: string }
  /**
   * Facepunch answered in a way Conduit doesn't recognise: `/app` served a page
   * instead of the redirect (its Windows block), a redirect without a token, or
   * the window was closed after `/app` redirected somewhere unexpected. The
   * reason is token-free and meant for the log.
   */
  | { kind: "flow-changed"; reason: string }
  /** Steam sign-in finished, but the Rust+ Companion API registration failed. */
  | { kind: "registration-failed" }
  /** Registration failed before the sign-in window opened (push service, network). */
  | { kind: "unreachable" };

/** The failures the Steam window itself reports through `onFailed`. */
export type SteamWindowFailure = Extract<SteamSignInFailure, { kind: "refused" | "flow-changed" }>;

/** Carries a {@link SteamSignInFailure} out of the Steam window, through fcm, to the wizard. */
export class SteamSignInError extends Error {
  readonly failure: SteamSignInFailure;

  constructor(failure: SteamSignInFailure) {
    super(
      "reason" in failure
        ? `Steam sign-in ${failure.kind}: ${failure.reason}`
        : `Steam sign-in ${failure.kind}`,
    );
    this.name = "SteamSignInError";
    this.failure = failure;
  }
}

/** Maximum depth of `cause` chain to search (guards against cycles). */
const MAX_CAUSE_DEPTH = 8;

/**
 * Work out why a Connect Steam attempt failed. A {@link SteamSignInError}
 * anywhere in the `cause` chain wins; otherwise the stage decides: after the
 * Steam token was captured it was the registration, before it the setup.
 */
export function classifySteamConnectError(
  err: unknown,
  progress: { tokenCaptured: boolean },
): SteamSignInFailure {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current instanceof SteamSignInError) return current.failure;
    current = current.cause;
  }
  return progress.tokenCaptured ? { kind: "registration-failed" } : { kind: "unreachable" };
}

/** What the wizard shows for a failure. */
export interface SteamFailureCopy {
  /** Inline message on the Steam step. Never contains a token or URL query. */
  message: string;
  /** Show a "Copy diagnostics" button: retrying likely won't help, so report it. */
  offerDiagnostics: boolean;
}

/** A Login Failed reason short and plain enough to show the user. */
const SHOWABLE_REASON = /^[A-Za-z0-9 _-]{1,40}$/;

/** Map a failure to distinct wizard copy that says whether to retry. */
export function steamFailureCopy(failure: SteamSignInFailure): SteamFailureCopy {
  switch (failure.kind) {
    case "cancelled":
      return {
        message: "Sign-in was cancelled. Click Connect Steam when you're ready to try again.",
        offerDiagnostics: false,
      };
    case "refused": {
      const said = SHOWABLE_REASON.test(failure.reason)
        ? ` (Facepunch said: ${failure.reason})`
        : "";
      return {
        message: `Facepunch's login didn't go through${said}. This is usually temporary, so please try again.`,
        offerDiagnostics: false,
      };
    }
    case "flow-changed":
      return {
        message:
          "Facepunch's sign-in didn't finish the way Conduit expects, so it may have changed. " +
          "Trying again probably won't help. Click Copy diagnostics and include it when you report this.",
        offerDiagnostics: true,
      };
    case "registration-failed":
      return {
        message:
          "You signed in to Steam, but Rust+ didn't accept the registration. Try again in a minute. " +
          "If it keeps failing, click Copy diagnostics and include it when you report this.",
        offerDiagnostics: true,
      };
    case "unreachable":
      return {
        message:
          "Couldn't reach the Rust+ services to start sign-in. Check your internet connection and try again.",
        offerDiagnostics: false,
      };
  }
}

/**
 * The wizard event for a failure. Cancelling is not an error: the step goes
 * back to idle with a neutral note. Everything else marks the step failed.
 */
export function steamFailureEvent(failure: SteamSignInFailure): WizardEvent {
  const { message, offerDiagnostics } = steamFailureCopy(failure);
  if (failure.kind === "cancelled") return { type: "steam.cancelled", message };
  return { type: "steam.error", message, offerDiagnostics };
}

/**
 * The status window's line after "Sign in with Steam again" (outside the
 * wizard): success, or the failure's copy. Cancelling is not an error.
 */
export function steamRenewalResult(failure: SteamSignInFailure | undefined): SteamRenewalResult {
  if (!failure) {
    return { ok: true, message: "Signed in again. Conduit is reconnecting to your servers." };
  }
  if (failure.kind === "cancelled") {
    return { ok: false, message: "Sign-in was cancelled. Nothing was changed." };
  }
  return { ok: false, message: steamFailureCopy(failure).message };
}
