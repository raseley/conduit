#!/usr/bin/env node
/**
 * gen-proto.mjs — regenerate `@conduit/rustplus-proto` from the vendored
 * `proto/rustplus.proto` (invoked by root `pnpm gen:proto`).
 *
 * Codegen tool: **protobufjs static-module** (`pbjs` + `pbts`), NOT ts-proto.
 * The canonical `protoc` compiler is intentionally avoided because it is not
 * available in this environment (no system install, no sudo). protobufjs ships
 * a pure-JS parser/generator, so no native toolchain is required — `protobufjs`
 * is a supported alternative to ts-proto.
 *
 * Output:
 *   packages/rustplus-proto/src/generated/rustplus.js   (ESM static module)
 *   packages/rustplus-proto/src/generated/rustplus.d.ts (type declarations)
 *
 * The generated directory is gitignored; codegen is deterministic, so the
 * files are left on disk after generation for downstream packages to consume.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const protoFile = resolve(repoRoot, "proto/rustplus.proto");
const pkgDir = resolve(repoRoot, "packages/rustplus-proto");
const outDir = resolve(pkgDir, "src/generated");
const jsOut = resolve(outDir, "rustplus.js");
const dtsOut = resolve(outDir, "rustplus.d.ts");

function fail(msg) {
  console.error(`\n[gen-proto] ${msg}\n`);
  process.exit(1);
}

if (!existsSync(protoFile)) {
  fail(`Schema not found at ${protoFile}. The vendored rustplus.proto is missing.`);
}

// Resolve pbjs / pbts from the package's node_modules (protobufjs-cli devDep).
const isWindows = process.platform === "win32";
function resolveBin(name) {
  const binName = isWindows ? `${name}.cmd` : name;
  const candidates = [
    resolve(pkgDir, "node_modules/.bin", binName),
    resolve(repoRoot, "node_modules/.bin", binName),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const pbjs = resolveBin("pbjs");
const pbts = resolveBin("pbts");

if (!pbjs || !pbts) {
  fail(
    [
      "pbjs/pbts (protobufjs-cli) not found.",
      "Run `pnpm install` so @conduit/rustplus-proto's devDependency `protobufjs-cli` is present.",
    ].join("\n"),
  );
}

mkdirSync(outDir, { recursive: true });

function run(label, bin, args) {
  console.log(`[gen-proto] ${label}`);
  const result = spawnSync(bin, args, { stdio: "inherit", shell: isWindows });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited with code ${result.status}.`);
}

// 1. Emit the static ESM module (typed messages + encode/decode).
run("generating static module → rustplus.js", pbjs, [
  "--target",
  "static-module",
  "--wrap",
  "es6",
  "--es6",
  "--keep-case",
  "--force-long",
  "--no-create",
  "--no-verify",
  "--no-convert",
  "--no-delimited",
  "--out",
  jsOut,
  protoFile,
]);

// 2. Emit the matching .d.ts from the generated module.
run("generating declarations → rustplus.d.ts", pbts, ["--out", dtsOut, jsOut]);

// 3. Fix the protobufjs runtime import for Node's strict ESM (NodeNext).
//    pbjs emits `import * as $protobuf from "protobufjs/minimal"`, which breaks
//    under Node ESM two ways: (a) protobufjs ships no `exports` map, so the
//    extensionless subpath fails to resolve — needs `.js`; (b) protobufjs/minimal
//    is CommonJS, so a namespace import exposes the API only under `.default`,
//    leaving `$protobuf.roots` undefined. A default import fixes both.
//    pbjs from protobufjs-cli 2 (protobufjs 8) already emits that default import,
//    so an already-correct line is left as it is.
{
  const src = readFileSync(jsOut, "utf8");
  const esmImport = 'import $protobuf from "protobufjs/minimal.js";';
  const patched = src.includes(esmImport)
    ? src
    : src.replace(/import \* as \$protobuf from "protobufjs\/minimal";/, esmImport);
  if (src.includes(esmImport)) {
    console.log("[gen-proto] protobufjs import is already Node ESM-safe");
  } else if (patched !== src) {
    console.log("[gen-proto] patched protobufjs import for Node ESM (NodeNext)");
  } else {
    fail(
      "expected protobufjs import line not found in generated module; " +
        "the pbjs output format may have changed — update the patch in gen-proto.mjs.",
    );
  }
  writeFileSync(jsOut, patched);
}

console.log("[gen-proto] done.");
