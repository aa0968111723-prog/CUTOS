import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Local object-storage abstraction. All generated media (uploaded sources,
 * synthesized samples, rendered exports) lives under a single data root that is
 * git-ignored. Swapping this for S3/GCS later only touches this module.
 */
const DATA_ROOT = process.env.CUTOS_DATA_DIR ?? join(process.cwd(), ".data");

export const paths = {
  root: DATA_ROOT,
  samples: join(DATA_ROOT, "samples"),
  sources: join(DATA_ROOT, "sources"),
  exports: join(DATA_ROOT, "exports"),
};

export async function ensureDataDirs(): Promise<void> {
  await Promise.all([
    mkdir(paths.samples, { recursive: true }),
    mkdir(paths.sources, { recursive: true }),
    mkdir(paths.exports, { recursive: true }),
  ]);
}
