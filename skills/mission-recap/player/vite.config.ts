// Builds the recap player (player/main.ts + the app's src/replay renderer) into ONE self-contained IIFE,
// skills/mission-recap/scripts/player.js, which recap.mjs inlines into the page it writes. Fonts and the
// GIF worker are inlined too, so the page works offline from file://.
//
//   npx vite build --config skills/mission-recap/player/vite.config.ts
//
// The built file is committed: the skill must work without a build step.

import { defineConfig, type Plugin } from "vite";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const HEADER = `/*! Gridkeeper mission-recap player (https://github.com/raazi29/gridkeeper, MIT).
 * GENERATED FILE, do not edit. Source: skills/mission-recap/player/main.ts + src/replay/*.
 * Rebuild from the repo root: npx vite build --config skills/mission-recap/player/vite.config.ts
 * Embeds Geist, Geist Mono and Space Grotesk (latin subsets, SIL Open Font License 1.1). */
`;

/** Prepend the header after minification (a banner would be stripped). */
function header(): Plugin {
  return {
    name: "recap-header",
    generateBundle(_opts, bundle) {
      for (const out of Object.values(bundle)) if (out.type === "chunk") out.code = HEADER + out.code;
    },
  };
}

export default defineConfig({
  root: at("."),
  publicDir: false,
  plugins: [header()],
  worker: { format: "iife" },
  build: {
    outDir: at("../scripts"),
    emptyOutDir: false,
    target: "es2020",
    minify: true,
    sourcemap: false,
    reportCompressedSize: false,
    assetsInlineLimit: () => true,
    lib: {
      entry: at("./main.ts"),
      formats: ["iife"],
      name: "GridkeeperRecapPlayer",
      fileName: () => "player.js",
    },
  },
});
