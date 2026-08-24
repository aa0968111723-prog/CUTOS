"use client";

import { useCallback, useEffect, useState } from "react";
import { getHealth } from "../lib/api.js";
import type { HealthDTO, SubsystemCheckDTO, VersionDTO } from "../lib/types.js";
import { UPLOAD_PROTOCOL_VERSION } from "../lib/upload-protocol.js";
import { overallLabel, statusLabel, subsystemLabel } from "../lib/diagnostics-label.js";
import { t } from "../i18n/index.js";

/**
 * The 系統狀態 panel: what an operator needs, kept out of everyone else's way.
 *
 * It is not a dashboard and does not try to be. It answers the four questions
 * that were unanswerable while production was quietly broken — which build is
 * this, can it store a video, can it read one, is the queue alive — and for
 * anything that is failing it shows the remedy rather than the stack trace.
 *
 * A normal user never opens it. That is why it lives behind one small header
 * button and renders nothing until asked.
 */
export function SystemStatusPanel({ onClose }: { onClose: () => void }) {
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setHealth(await getHealth());
    } catch {
      // The panel's own job is to report brokenness, so it must render a
      // useful state when the thing it is reporting on will not answer.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="status-overlay" role="dialog" aria-modal="true" aria-label={t("status.title")}>
      <div className="status-panel">
        <header className="status-head">
          <h2>{t("status.title")}</h2>
          <div className="row">
            <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              {t("status.refresh")}
            </button>
            <button className="btn btn-sm" onClick={onClose}>
              {t("status.close")}
            </button>
          </div>
        </header>

        {loading && !health && (
          <p className="muted">
            <span className="spinner" /> {t("status.loading")}
          </p>
        )}
        {failed && !health && <p className="upload-error">{t("status.unreachable")}</p>}

        {health && (
          <>
            <p className={`status-overall status-${health.status}`}>
              {overallLabel(health.status)}
              <span className="muted status-meta">
                {" · "}
                {t("status.checkedAt", { time: formatTime(health.checkedAt) })}
                {" · "}
                {t("status.uptime", { minutes: Math.round(health.uptimeSeconds / 60) })}
              </span>
            </p>

            <VersionSection version={health.version} />

            <section className="status-section">
              <h3>{t("status.section.storage")}</h3>
              {pick(health, ["dataDirWritable", "database", "storage", "uploadSubsystem"]).map(
                (check) => (
                  <CheckRow key={check.name} check={check} />
                ),
              )}
            </section>

            <section className="status-section">
              <h3>{t("status.section.media")}</h3>
              {pick(health, ["ffprobe", "ffmpeg"]).map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
            </section>

            <section className="status-section">
              <h3>{t("status.section.worker")}</h3>
              {pick(health, ["jobWorker"]).map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
            </section>

            <AiosSection />
          </>
        )}
      </div>
    </div>
  );
}

function pick(health: HealthDTO, names: string[]): SubsystemCheckDTO[] {
  // Ordered by `names`, and tolerant of a server that reports a check this
  // build has never heard of — or omits one it expects.
  return names
    .map((name) => health.checks.find((c) => c.name === name))
    .filter((c): c is SubsystemCheckDTO => c !== undefined);
}

function CheckRow({ check }: { check: SubsystemCheckDTO }) {
  return (
    <div className={`status-row status-${check.status}`}>
      <span className="status-dot" aria-hidden="true" />
      <div className="status-row-body">
        <p className="status-row-name">
          {subsystemLabel(check.name)}
          <span className={`badge badge-${check.status}`}>{statusLabel(check.status)}</span>
        </p>
        <p className="muted status-row-summary">{check.summary}</p>
        {check.remedy && (
          <p className="status-row-remedy">{t("status.remedy", { text: check.remedy })}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Which build is serving this page.
 *
 * The `uploadProtocolVersion` comparison is the point of the whole section: it
 * is the one field that says, without anybody reading a commit graph, whether
 * the running server predates the streaming-upload fix.
 */
function VersionSection({ version }: { version: VersionDTO }) {
  const unknown = t("status.version.unknown");
  const stale = version.uploadProtocolVersion < UPLOAD_PROTOCOL_VERSION;

  return (
    <section className="status-section">
      <h3>{t("status.section.version")}</h3>
      <dl className="status-facts">
        <Fact label={t("status.version.app")} value={version.appVersion} />
        <Fact
          label={t("status.version.commit")}
          value={version.gitShaShort ?? unknown}
          title={version.gitSha ?? undefined}
          mono
        />
        <Fact label={t("status.version.branch")} value={version.gitBranch ?? unknown} />
        <Fact
          label={t("status.version.buildTime")}
          value={version.buildTime ? formatTime(version.buildTime) : unknown}
        />
        <Fact
          label={t("status.version.uploadProtocol")}
          value={String(version.uploadProtocolVersion)}
        />
      </dl>
      {stale && <p className="status-row-remedy">{t("status.version.stale")}</p>}
    </section>
  );
}

function Fact({
  label,
  value,
  title,
  mono,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined} title={title}>
        {value}
      </dd>
    </>
  );
}

/**
 * AIOS reports separately because it is genuinely optional.
 *
 * An unconfigured kernel is not a fault and must not read as one — video upload
 * and editing work perfectly without it — so this says so in words rather than
 * showing a red row an operator would waste time chasing.
 */
function AiosSection() {
  const [state, setState] = useState<"loading" | "configured" | "absent">("loading");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/aios/health", { cache: "no-store" })
      .then((res) => res.json() as Promise<{ configured?: boolean }>)
      .then((body) => {
        if (!cancelled) setState(body.configured ? "configured" : "absent");
      })
      .catch(() => {
        if (!cancelled) setState("absent");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="status-section">
      <h3>{t("status.section.aios")}</h3>
      <p className="muted">
        {state === "loading"
          ? t("status.loading")
          : state === "configured"
            ? t("status.aios.configured")
            : t("status.aios.notConfigured")}
      </p>
    </section>
  );
}

/** Local-time rendering that never throws on a malformed timestamp. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-TW", { hour12: false });
}
