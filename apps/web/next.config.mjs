import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Deliberately NOT `output: "standalone"`. Standalone would give a smaller
  // image, but it also changes the start command to `node server.js`, and this
  // deployment's problem has never been image size — it has been uncertainty
  // about what is running. One start command (`pnpm start`) in development, in
  // CI, in Docker and on the platform is worth more here than a smaller layer.
  //
  // Runs apps/web/instrumentation.ts once at boot. That is where the deployment
  // validates its data directory, database, storage and media binaries and logs
  // anything broken — before a user can upload into it. See the `nextRuntime`
  // alias in `webpack` below for why the Node-only half needs excluding from
  // the edge bundle.
  experimental: {
    instrumentationHook: true,
  },
  // The shared workspace packages export TypeScript source; let Next transpile
  // them instead of requiring a separate build step per package.
  transpilePackages: [
    "@cutos/edit-dsl",
    "@cutos/timeline",
    "@cutos/media",
    "@cutos/agent",
    "@cutos/jobs",
    "@cutos/storage",
    "@cutos/project-store",
    "@cutos/preview",
  ],
  webpack: (config, { nextRuntime }) => {
    // Allow explicit ".js" specifiers in TypeScript source to resolve to the
    // corresponding ".ts"/".tsx" files (matching the TS "Bundler" resolution
    // used across the monorepo).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    // Next compiles instrumentation.ts for the edge runtime too, and webpack
    // follows its dynamic import there even though `NEXT_RUNTIME` guards it at
    // runtime — so the preflight module's node:fs / node:child_process imports
    // would fail the build. Resolving that ONE file to an empty module in the
    // edge bundle is precise: the guard already means it is never called there,
    // and naming the exact path keeps this from masking any other import.
    if (nextRuntime === "edge") {
      config.resolve.alias = {
        ...config.resolve.alias,
        [join(appDir, "server/preflight-entry.ts")]: false,
      };
    }
    return config;
  },
};

export default nextConfig;
