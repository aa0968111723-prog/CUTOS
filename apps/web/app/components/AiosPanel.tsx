"use client";

import { useState } from "react";
import type { IntegrationDTO } from "../lib/types.js";
import { checkAiosHealth, type AiosHealth } from "../lib/api.js";
import { t, type MessageKey } from "../i18n/index.js";

function providerLabel(provider: IntegrationDTO["provider"]): string {
  const key = `aios.provider${provider === "aios" ? "Aios" : provider === "openai" ? "Openai" : "Local"}` as MessageKey;
  return t(key);
}

/** Shows the active planner + AIOS kernel connection and the outbound bridge. */
export function AiosPanel({ integration }: { integration: IntegrationDTO }) {
  const connected = integration.aios.configured;
  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<AiosHealth | null>(null);

  const runTest = async () => {
    setTesting(true);
    setHealth(null);
    try {
      setHealth(await checkAiosHealth());
    } catch {
      setHealth({ configured: connected, reachable: false });
    } finally {
      setTesting(false);
    }
  };

  const healthText = (): string | null => {
    if (!health) return null;
    if (!health.configured) return t("aios.notConfigured");
    return health.reachable ? t("aios.reachable", { ms: health.latencyMs ?? 0 }) : t("aios.unreachable");
  };
  return (
    <div className="card aios-panel">
      <h2>{t("aios.title")}</h2>
      <dl className="inspector">
        <div>
          <dt>{t("aios.provider")}</dt>
          <dd>{providerLabel(integration.provider)}</dd>
        </div>
        <div>
          <dt>{t("aios.status")}</dt>
          <dd>
            <span className={`status-dot ${connected ? "ok" : "off"}`} aria-hidden />
            {connected ? t("aios.connected") : t("aios.notConnected")}
          </dd>
        </div>
        {connected && (
          <>
            <div>
              <dt>{t("aios.kernel")}</dt>
              <dd className="mono">{integration.aios.kernelUrl}</dd>
            </div>
            <div>
              <dt>{t("aios.model")}</dt>
              <dd className="mono">
                {integration.aios.model}@{integration.aios.backend}
              </dd>
            </div>
          </>
        )}
      </dl>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 6px" }}>{t("aios.bridge")}</p>
      <div className="row">
        <button className="btn btn-sm" onClick={() => void runTest()} disabled={testing}>
          {testing ? <span className="spinner" /> : t("aios.test")}
        </button>
        <a className="btn btn-sm btn-ghost" href="/api/aios/manifest" target="_blank" rel="noreferrer">
          {t("aios.manifest")}
        </a>
      </div>
      {health && (
        <p
          className="muted"
          style={{ fontSize: 12, marginTop: 8, color: health.reachable ? "var(--success)" : undefined }}
        >
          {healthText()}
        </p>
      )}
    </div>
  );
}
