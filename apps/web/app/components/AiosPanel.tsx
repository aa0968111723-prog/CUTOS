"use client";

import { useState } from "react";
import type { IntegrationDTO } from "../lib/types.js";
import { checkAiosHealth, type AiosHealth } from "../lib/api.js";
import { t, type MessageKey } from "../i18n/index.js";
import { CUTOS_PROTOCOL_VERSION } from "@cutos/protocol/version";

const PROTOCOL: string = CUTOS_PROTOCOL_VERSION;

/** Bridge feature flag → zh-TW label. Unknown flags fall back to the raw name. */
const FEATURE_KEYS: Record<string, MessageKey> = {
  semantic: "aios.feature.semantic",
  idempotency: "aios.feature.idempotency",
  "revision-guard": "aios.feature.revisionGuard",
  approval: "aios.feature.approval",
  "activity-log": "aios.feature.activityLog",
  "long-running-jobs": "aios.feature.longRunningJobs",
  cancellation: "aios.feature.cancellation",
  orchestrator: "aios.feature.orchestrator",
};

function providerLabel(provider: IntegrationDTO["provider"]): string {
  const suffix =
    provider === "aios"
      ? "Aios"
      : provider === "openai"
        ? "Openai"
        : provider === "zeabur"
          ? "Zeabur"
          : "Local";
  const key = `aios.provider${suffix}` as MessageKey;
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
    // Kernel state is what "connected" means to the user; the v2 fields below
    // describe the bridge CUTOS itself serves and are always present.
    if (!health.kernel?.configured && !health.configured) return t("aios.notConfigured");
    const reachable = health.kernel?.reachable ?? health.reachable;
    const ms = health.kernel?.latencyMs ?? health.latencyMs ?? 0;
    return reachable ? t("aios.reachable", { ms }) : t("aios.unreachable");
  };

  /** Protocol compatibility is a first-class state: never a silent fallback. */
  const protocolCompatible = (): boolean =>
    !health?.supportedProtocols || health.supportedProtocols.includes(PROTOCOL);

  const featureLabel = (feature: string): string => {
    const key = FEATURE_KEYS[feature];
    return key ? t(key) : feature;
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
        <div>
          <dt>{t("aios.protocol")}</dt>
          <dd className="mono">
            {health?.protocolVersion ?? PROTOCOL}
            {health && !protocolCompatible() ? ` — ${t("aios.protocolIncompatible")}` : ""}
          </dd>
        </div>
        <div>
          <dt>{t("aios.orchestration")}</dt>
          <dd>{connected ? t("aios.orchestrated") : t("aios.selfDriven")}</dd>
        </div>
        {health?.features?.length ? (
          <div>
            <dt>{t("aios.features")}</dt>
            <dd>{health.features.map(featureLabel).join("、")}</dd>
          </div>
        ) : null}
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
