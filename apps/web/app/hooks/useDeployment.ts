"use client";

import { useCallback, useEffect, useState } from "react";
import { getReadiness } from "../lib/api.js";
import type { ReadinessDTO } from "../lib/types.js";

/**
 * Whether this deployment can actually do the thing the page is about to offer.
 *
 * The failure this prevents is specific: a container whose data directory is
 * read-only accepts a file picker, accepts a session, accepts chunks, and then
 * destroys the upload — and the user finds out several minutes into sending a
 * video over mobile data. The deployment already knows it is broken before any
 * of that happens. Asking costs one request on mount.
 *
 * Deliberately fails OPEN. If readiness cannot be reached — a blip, an old
 * build with no such endpoint, an offline phone — the UI behaves exactly as it
 * did before. Only an explicit "I cannot store bytes" from the server is
 * allowed to take the upload button away, because a diagnostic that blocks
 * working deployments is worse than the bug it was meant to catch.
 */
export interface Deployment {
  readiness: ReadinessDTO | null;
  loading: boolean;
  /** The deployment says it cannot store an upload. Block the picker. */
  blocksUpload: boolean;
  /** It can store bytes but cannot read them. Warn, but let the user proceed. */
  warnsProcessing: boolean;
  refresh: () => Promise<void>;
}

export function useDeployment(): Deployment {
  const [readiness, setReadiness] = useState<ReadinessDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReadiness(await getReadiness());
    } catch {
      // Unreachable or unparseable: fail open, per the docstring.
      setReadiness(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    readiness,
    loading,
    blocksUpload: readiness !== null && readiness.canAcceptUploads === false,
    warnsProcessing:
      readiness !== null && readiness.canAcceptUploads && readiness.canProcessMedia === false,
    refresh,
  };
}
