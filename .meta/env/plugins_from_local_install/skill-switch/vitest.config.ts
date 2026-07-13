import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      // 仅统计本次单测目标范围的覆盖率，避免无关源文件污染数据
      include: [
        "src/skill-injection-hook.ts",
        "src/utils.ts",
        "src/session-state.ts",
        "src/skill-discovery.ts",
        "src/conversation-source.ts",
        "src/handoff-source.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "node_modules",
        "dist",
      ],
    },
  },
});
