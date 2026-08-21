"use client";

import { useRef } from "react";
import type { ChangeEvent } from "react";
import type { Editor } from "../hooks/useEditor.js";
import { formatSeconds } from "../lib/format.js";
import { errorMessage, t } from "../i18n/index.js";
import { UploadProgress } from "./UploadProgress.js";

/** Phases during which the picker must stay locked. */
const IN_FLIGHT = new Set(["preparing", "uploading", "uploaded", "probing"]);

export function ImportView({ editor }: { editor: Editor }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = IN_FLIGHT.has(editor.upload.phase);
  // The demo import is the only thing that still holds the shared `busy` flag;
  // an upload has its own state and must not be gated on it.
  const importing = editor.busy !== null;

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input first: picking the same file twice after a failure must
    // still fire a change event.
    if (fileRef.current) fileRef.current.value = "";
    if (file) void editor.startUpload(file);
  };

  return (
    <section className="card">
      <h2>{t("home.importTitle")}</h2>
      <p className="muted">{t("home.importHint")}</p>
      <div className="row">
        <button
          className="btn btn-primary"
          onClick={() => void editor.importSample()}
          disabled={importing || uploading}
        >
          {importing ? <span className="spinner" /> : t("home.loadDemo")}
        </button>
        <button
          className="btn"
          onClick={() => fileRef.current?.click()}
          disabled={importing || uploading}
        >
          {t("home.upload")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,audio/*"
          hidden
          onChange={onPick}
          aria-label={t("home.upload")}
        />
      </div>
      {importing && <p className="muted" style={{ marginTop: 12 }}>{editor.busy}</p>}

      <UploadProgress
        upload={editor.upload}
        onCancel={editor.cancelUpload}
        onRetryProbe={(id) => void editor.retryProbe(id)}
        onPickAnother={() => {
          editor.resetUpload();
          fileRef.current?.click();
        }}
      />

      {editor.projects.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2>{t("home.recentProjects")}</h2>
          {editor.projects.map((p) => {
            const processing = p.mediaStatus === "uploaded" || p.mediaStatus === "probing";
            return (
              <div key={p.id} className="history-item">
                <button className="linklike" onClick={() => void editor.openProject(p.id)}>
                  {p.name}
                  {/* A project whose media is still being read is listed and
                      openable — it never blocks the rest of the home screen. */}
                  {processing && <span className="badge badge-soft">{t("media.processing")}</span>}
                  {p.mediaStatus === "failed" && (
                    <span className="badge badge-warn">
                      {errorMessage(p.mediaError ?? "PROBE_FAILED")}
                    </span>
                  )}
                  {p.mediaStatus === "ready" && <span className="muted"> · {formatSeconds(p.durationMs)}</span>}
                </button>
                {p.mediaStatus === "failed" && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void editor.retryProbe(p.id)}>
                    {t("upload.retryProbe")}
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => void editor.removeProject(p.id)}>
                  {t("sidebar.delete")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
