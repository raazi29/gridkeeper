import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/; never collect their copies of the tests.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "src-tauri/**"],
  },
});
