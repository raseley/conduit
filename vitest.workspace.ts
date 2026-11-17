import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/rustplus-proto",
  "packages/rustplus-client",
  "packages/fcm",
  "packages/bot-core",
  "packages/discord",
  "apps/desktop",
]);
