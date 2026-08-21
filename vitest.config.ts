import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "apps/**/server/**/*.test.ts",
      "apps/**/i18n/**/*.test.ts",
      // The browser-side upload state machine is transport-injectable so it
      // runs here, in node, against a fake transport.
      "apps/**/app/lib/**/*.test.ts",
    ],
    environment: "node",
    passWithNoTests: false,
    // `node:sqlite` is a newer built-in that Vite's resolver does not yet know
    // about; keep it external so tests can import it directly.
    server: {
      deps: {
        external: [/node:sqlite/],
      },
    },
  },
});
