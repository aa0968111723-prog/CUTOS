/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared workspace packages export TypeScript source; let Next transpile
  // them instead of requiring a separate build step per package.
  transpilePackages: ["@cutos/edit-dsl", "@cutos/timeline", "@cutos/media", "@cutos/agent"],
  webpack: (config) => {
    // Allow explicit ".js" specifiers in TypeScript source to resolve to the
    // corresponding ".ts"/".tsx" files (matching the TS "Bundler" resolution
    // used across the monorepo).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
