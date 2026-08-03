import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": new URL(".", import.meta.url).pathname },
  },
  test: {
    environment: "node",
    /*
     * The repo's Playwright e2e suite also matches vitest's default
     * `*.test.ts` glob. `tests/e2e/**` holds real Playwright specs, and
     * `lib/ai/models.test.ts` is a `.test.ts`-named mock-model helper
     * consumed by them, not a Vitest test itself — both are excluded so
     * `pnpm test` only runs Vitest suites.
     */
    exclude: [
      ...configDefaults.exclude,
      "tests/e2e/**",
      "lib/ai/models.test.ts",
    ],
  },
});
