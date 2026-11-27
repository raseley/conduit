// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Layer boundaries — the core invariant of the codebase (see CLAUDE.md
 * "Architecture"):
 *
 *   rustplus-proto ← rustplus-client ← bot-core ← discord
 *                          fcm        ←
 *                                      all ← apps/desktop
 *
 * Each package gets a `files`-scoped `no-restricted-imports` rule expressed as
 * an ALLOWLIST of workspace packages (`@conduit/*` minus the tiers it may reach),
 * so a newly-added package is forbidden everywhere until a tier opts in. Type-only
 * imports count too: a type dependency is still a dependency.
 *
 * @param {string} dir          package directory, e.g. "packages/bot-core"
 * @param {string[]} allowed    workspace packages this tier may import
 * @param {string[]} forbidden  third-party runtimes this tier must not touch
 */
function layerBoundary(dir, allowed, forbidden) {
  const tier = dir.split("/").pop();
  const allowedText = allowed.length > 0 ? allowed.join(", ") : "no other workspace package";
  return {
    files: [`${dir}/**/*.{ts,mts,cts,js,mjs,cjs}`],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@conduit/*", ...allowed.map((name) => `!${name}`)],
              message: `Layer boundary: ${tier} may import ${allowedText}. See CLAUDE.md "Architecture".`,
            },
            ...(forbidden.length > 0
              ? [
                  {
                    group: forbidden.flatMap((name) => [name, `${name}/*`]),
                    message: `Layer boundary: ${tier} must stay free of ${forbidden.join(" / ")}. See CLAUDE.md "Architecture".`,
                  },
                ]
              : []),
            {
              // A relative path that climbs out of the package and into a sibling
              // is the same violation wearing a disguise.
              regex:
                "^(\\.\\./)+(packages/|apps/|(rustplus-proto|rustplus-client|fcm|bot-core|discord|desktop)/)",
              message:
                "Layer boundary: import other workspace packages by their @conduit/* name, never by relative path.",
            },
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/src/generated/**",
      "release/**",
      "dist-electron/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts and config files run in the Node.js runtime (as does the icon
    // generator, apps/desktop/assets/icon/render.mjs).
    files: [
      "scripts/**/*.{js,mjs,cjs}",
      "*.{js,mjs,cjs,ts}",
      "**/scripts/**/*.{js,mjs,cjs}",
      "**/assets/icon/*.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The desktop renderer runs in a browser (DOM) context, talking only to the
    // typed `window.conduit` preload bridge. Plain ESM JS.
    files: ["apps/desktop/src/renderer/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    rules: {
      // Pragmatic, not pedantic.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  // Enforced layer boundaries. apps/desktop is the composition root and may
  // import every tier, so it has no rule.
  layerBoundary("packages/rustplus-proto", [], ["electron", "discord.js"]),
  layerBoundary(
    "packages/rustplus-client",
    ["@conduit/rustplus-proto"],
    ["electron", "discord.js"],
  ),
  // fcm's push client carries its own small protobuf codec (src/push/wire.ts), so
  // protobufjs and long, which only the old push library needs, stay out of it.
  layerBoundary("packages/fcm", [], ["electron", "discord.js", "protobufjs", "long"]),
  layerBoundary(
    "packages/bot-core",
    ["@conduit/rustplus-client", "@conduit/fcm"],
    ["electron", "discord.js"],
  ),
  layerBoundary("packages/discord", ["@conduit/bot-core"], ["electron"]),
  prettier,
);
