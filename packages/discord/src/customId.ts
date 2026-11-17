/**
 * Structured `customId` scheme.
 *
 * Every component interaction is routed through one dispatcher keyed off a
 * structured id of the form:
 *
 *   conduit:v1:<domain>:<action>:<serverHandle>:<entityHandle>
 *
 * Handles (not raw uuids) keep the whole string well under Discord's 100-char
 * customId limit. The trailing handles are optional — guild-scoped controls
 * (e.g. the Setup hub) carry neither, server-scoped controls carry only the
 * server handle. Empty trailing segments are preserved so parsing is positional.
 */

/** customId namespace + version prefix; lets us evolve the scheme later. */
export const CUSTOM_ID_PREFIX = "conduit:v1";

/** Discord's hard limit on a component customId. */
export const CUSTOM_ID_MAX_LENGTH = 100;

/**
 * The object domain a customId addresses — every domain a current panel can
 * emit. (The Team panel was folded into the server status panel, so there is no
 * `team` domain any more.)
 */
export type CustomIdDomain =
  | "switch"
  /** A switch group: the entity handle is the group's handle. */
  | "group"
  | "alarm"
  | "monitor"
  | "camera"
  | "server"
  | "setup"
  | "pairing";

/** A parsed customId. `server`/`entity` are the *handles*, not ids. */
export interface ParsedCustomId {
  domain: CustomIdDomain;
  action: string;
  /** Server handle, when the control is server- or entity-scoped. */
  server?: string;
  /** Entity handle, when the control is entity-scoped. */
  entity?: string;
}

/** Fields used to build a customId. */
export interface CustomIdParts {
  domain: CustomIdDomain;
  action: string;
  server?: string;
  entity?: string;
}

/**
 * Build a customId from its parts. Throws if the result would exceed Discord's
 * limit (which, with short handles, only happens on a misuse such as passing a
 * raw uuid as a handle — a useful guard during development).
 */
export function buildCustomId(parts: CustomIdParts): string {
  const segments = [
    CUSTOM_ID_PREFIX,
    parts.domain,
    parts.action,
    parts.server ?? "",
    parts.entity ?? "",
  ];
  // Trim trailing empty segments so guild-scoped ids stay compact.
  while (segments.length > 0 && segments[segments.length - 1] === "") {
    segments.pop();
  }
  const id = segments.join(":");
  if (id.length > CUSTOM_ID_MAX_LENGTH) {
    throw new Error(`customId exceeds ${CUSTOM_ID_MAX_LENGTH} chars (${id.length}): ${id}`);
  }
  return id;
}

/**
 * Parse a customId back into its parts. Returns `undefined` for any id that
 * isn't ours (wrong prefix/version) or is malformed, so the dispatcher can
 * cleanly ignore foreign components.
 *
 * Only the *shape* is validated. The domain segment is not checked against
 * {@link CustomIdDomain}: an id that is ours but names a domain this build does
 * not route (a button on a panel posted by an older version) still parses, so
 * the dispatcher can permission-check and acknowledge it instead of leaving the
 * click to fail. Routing therefore must not assume the union is exhaustive.
 */
export function parseCustomId(customId: string): ParsedCustomId | undefined {
  const segments = customId.split(":");
  // prefix is two segments ("conduit", "v1"); then domain + action are required.
  if (segments.length < 4) return undefined;
  const [ns, version, domain, action, server, entity] = segments;
  if (`${ns}:${version}` !== CUSTOM_ID_PREFIX) return undefined;
  if (!domain || !action) return undefined;
  return {
    domain: domain as CustomIdDomain,
    action,
    server: server || undefined,
    entity: entity || undefined,
  };
}
