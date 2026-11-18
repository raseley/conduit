/**
 * Per-click role-based permission checks.
 *
 * Panels are shared messages: Discord cannot render a button enabled for one
 * viewer and disabled for another, so permission is enforced **at click time**.
 * The clicking member's Discord role ids are checked against the
 * {@link RoleCapabilityMap} before any `bot-core` call. Denial is an
 * ephemeral reply, never a silent no-op.
 *
 * This module is pure (no discord.js types) so it is trivially unit-testable:
 * it takes the member's role ids + the capability map and returns a decision.
 */

import type { Capability, RoleCapabilityMap } from "@conduit/bot-core";

/** Capability required to perform an action. */
export type RequiredCapability = Capability;

/**
 * Resolve the highest capability a set of role ids grants. `admin` implies
 * `user`. Returns `undefined` when the member holds no mapped role.
 */
export function resolveCapability(
  roleIds: Iterable<string>,
  map: RoleCapabilityMap,
): Capability | undefined {
  const roles = new Set(roleIds);
  if (map.admin.some((r) => roles.has(r))) return "admin";
  if (map.user.some((r) => roles.has(r))) return "user";
  return undefined;
}

/**
 * Decide whether a member with the given role ids may perform an action that
 * requires `required`. `admin` satisfies both `admin`- and `user`-gated actions;
 * `user` satisfies only `user`-gated actions.
 */
export function isAllowed(
  roleIds: Iterable<string>,
  map: RoleCapabilityMap,
  required: RequiredCapability,
): boolean {
  const capability = resolveCapability(roleIds, map);
  if (capability === "admin") return true;
  if (capability === "user") return required === "user";
  return false;
}

/**
 * The role names Conduit adopts when no roles are chosen, matched
 * case-insensitively: a server that names its roles this way works without
 * choosing them in `/conduit setup`.
 */
export const CONDUIT_ROLE_NAMES: Readonly<Record<Capability, string>> = {
  admin: "Conduit Admin",
  user: "Conduit",
};

/** A server role, as {@link adoptNamedRoles} reads it. */
export interface ServerRole {
  id: string;
  name: string;
  /** Owned by an integration (a bot's own role): never adopted. */
  managed: boolean;
}

/**
 * The role map to save when none is chosen yet: the server's role named
 * {@link CONDUIT_ROLE_NAMES} `admin` as the admin role, and the one named `user`
 * as the user role, either alone when only one exists. Returns `undefined`
 * (nothing to save) when any role is already chosen, since a choice made by hand
 * always wins, or when no role matches.
 *
 * Integration roles never match: Discord gives a bot a role named after it, and
 * the bot is usually called Conduit. A name that more than one role has is
 * ambiguous and left for the operator to choose.
 */
export function adoptNamedRoles(
  map: RoleCapabilityMap,
  roles: Iterable<ServerRole>,
): RoleCapabilityMap | undefined {
  if (map.admin.length > 0 || map.user.length > 0) return undefined;
  const candidates = [...roles].filter((r) => !r.managed);
  const named = (name: string): string[] => {
    const key = name.trim().toLowerCase();
    const matches = candidates.filter((r) => r.name.trim().toLowerCase() === key);
    return matches.length === 1 ? [matches[0]!.id] : [];
  };
  const adopted = { admin: named(CONDUIT_ROLE_NAMES.admin), user: named(CONDUIT_ROLE_NAMES.user) };
  return adopted.admin.length > 0 || adopted.user.length > 0 ? adopted : undefined;
}

/**
 * The capability each (domain, action) pair requires. Anything not
 * listed defaults to `admin` (fail closed). Reads/toggles are `user`; setup
 * and pairing are `admin`.
 */
const ACTION_CAPABILITY: Record<string, RequiredCapability> = {
  // switch
  "switch:on": "user",
  "switch:off": "user",
  "switch:refresh": "user",
  "switch:manage": "admin",
  "switch:settings": "admin",
  "switch:name": "admin",
  "switch:auto": "admin",
  "switch:delay": "admin",
  "switch:autodelay": "admin",
  "switch:remove": "admin",
  "switch:remove-confirm": "admin",
  "switch:remove-cancel": "admin",
  // switch group: its row's action is a user's, like a switch's; the
  // group's own panel (opened from the admin "Manage a switch…" select) and
  // everything in it are an admin's.
  "group:on": "user",
  "group:off": "user",
  "group:refresh": "user",
  "group:view": "admin",
  "group:member": "admin",
  "group:rename": "admin",
  "group:members": "admin",
  "group:setmembers": "admin",
  "group:create": "admin",
  "group:create-members": "admin",
  "group:delete": "admin",
  "group:delete-confirm": "admin",
  "group:delete-cancel": "admin",
  // alarm
  "alarm:manage": "admin",
  "alarm:settings": "admin",
  "alarm:severity": "admin",
  "alarm:notify": "admin",
  "alarm:name": "admin",
  "alarm:remove": "admin",
  "alarm:remove-confirm": "admin",
  "alarm:remove-cancel": "admin",
  // storage monitor: its settings hold Watch and Refresh, which any user may
  // use, so the "Manage a monitor…" select is open to users; Rename and Remove
  // inside it are checked on their own click.
  "monitor:contents": "user",
  "monitor:manage": "user",
  "monitor:settings": "user",
  "monitor:watch": "user",
  "monitor:refresh": "user",
  "monitor:name": "admin",
  "monitor:remove": "admin",
  "monitor:remove-confirm": "admin",
  "monitor:remove-cancel": "admin",
  // camera
  "camera:capture": "user",
  "camera:manage": "admin",
  "camera:settings": "admin",
  "camera:name": "admin",
  "camera:remove": "admin",
  "camera:remove-confirm": "admin",
  "camera:remove-cancel": "admin",
  // server status
  "server:refresh": "user",
  // setup hub (all admin)
  "setup:channel": "admin",
  "setup:adminRoles": "admin",
  "setup:userRoles": "admin",
  "setup:addCamera": "admin",
  "setup:cameraServer": "admin",
  "setup:cameraAdd": "admin",
  "setup:repost": "admin",
  "setup:startOnLogin": "admin",
  "setup:pushover": "admin",
  // naming a device (the label modal every device's Rename opens)
  "pairing:label": "admin",
};

/**
 * Look up the capability a (domain, action) requires. Fails closed to `admin`
 * for unknown pairs so a new, unmapped action can never be actuated by a
 * non-admin by accident.
 */
export function requiredCapabilityFor(domain: string, action: string): RequiredCapability {
  return ACTION_CAPABILITY[`${domain}:${action}`] ?? "admin";
}
