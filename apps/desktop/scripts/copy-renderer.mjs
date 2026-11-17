/**
 * Copy the static assets `tsc -b` does not emit into `dist/`:
 *
 * - the renderer (index.html, styles.css, app.js — plain ESM, DOM context),
 *   into `dist/renderer`; the main process loads `dist/renderer/index.html`;
 * - the shipped Conduit mark files (window icon, Discord bot avatar), from
 *   `assets/icon/` into `dist/assets/icon/`, where `src/asset-paths.ts` finds
 *   them. electron-builder only packages `dist/**`.
 */

import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const rendererDest = join(root, "dist", "renderer");
await mkdir(rendererDest, { recursive: true });
await cp(join(root, "src", "renderer"), rendererDest, { recursive: true });
console.log(`copied renderer assets → ${rendererDest}`);

// The list lives in src/asset-paths.ts; `tsc -b` has compiled it by now.
const { SHIPPED_ICON_FILES } = await import(
  new URL("../dist/asset-paths.js", import.meta.url).href
);
const iconDest = join(root, "dist", "assets", "icon");
await mkdir(iconDest, { recursive: true });
for (const file of SHIPPED_ICON_FILES) {
  await cp(join(root, "assets", "icon", file), join(iconDest, file.split("/").pop()));
}
console.log(`copied icon assets → ${iconDest}`);
