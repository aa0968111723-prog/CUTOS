"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  applyPlan,
  createSampleProject,
  discardPlan,
  redo,
  requestPlan,
  startAnalyze,
  startExport,
  undo,
  uploadProject,
  waitForJob,
} from "./lib/api.js";
import type { ProjectDTO } from "./lib/types.js";
import { formatMs, formatSeconds } from "./lib/format.js";
import { Strip, type StripItem } from "./components/Strip.js";

interface ChatMessage {
  role: "user" | "agent" | "error";
  text: string;
}

const SUGGESTIONS = [
  "Remove all silent pauses",
  "Remove pauses longer than 1 second",
  "Make the whole clip 2x faster",
];

export default function Page() {
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [instruction, setInstruction] = useState("");
  const [outputVersion, setOutputVersion] = useState(0);
  const [busy, setBusy] = useState<null | string>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const say = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { role, text }]);
  }, []);

  const runAnalysis = useCallback(
    async (id: string) => {
      setBusy("Analyzing audio for silent pauses…");
      try {
        const jobId = await startAnalyze(id, { thresholdDb: -30, minSilenceMs: 700 });
        const job = await waitForJob(jobId);
        if (job.status === "failed") throw new Error(job.error ?? "Analysis failed");
        const updated = await (await fetch(`/api/projects/${id}`, { cache: "no-store" })).json();
        setProject(updated as ProjectDTO);
        const count = (updated as ProjectDTO).analysis?.silences.length ?? 0;
        say(
          "agent",
          count > 0
            ? `I analyzed the audio and found ${count} silent pause${count === 1 ? "" : "s"}. ` +
                `Tell me what you'd like to do — e.g. "remove pauses longer than 1 second".`
            : `I analyzed the audio but didn't detect notable silence. You can still ask me to change speed.`,
        );
      } catch (error) {
        say("error", error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [say],
  );

  const importSample = useCallback(async () => {
    setBusy("Importing demo clip…");
    setMessages([]);
    try {
      const created = await createSampleProject();
      setProject(created);
      say("agent", `Imported "${created.name}" (${formatSeconds(created.source.durationMs)}).`);
      await runAnalysis(created.id);
    } catch (error) {
      say("error", error instanceof Error ? error.message : String(error));
      setBusy(null);
    }
  }, [runAnalysis, say]);

  const importUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setBusy("Uploading and probing your video…");
      setMessages([]);
      try {
        const created = await uploadProject(file);
        setProject(created);
        say("agent", `Imported "${created.name}" (${formatSeconds(created.source.durationMs)}).`);
        await runAnalysis(created.id);
      } catch (error) {
        say("error", error instanceof Error ? error.message : String(error));
        setBusy(null);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [runAnalysis, say],
  );

  const submitInstruction = useCallback(
    async (text: string) => {
      if (!project || !text.trim()) return;
      say("user", text);
      setInstruction("");
      setBusy("Agent is drafting an Edit Plan…");
      try {
        const updated = await requestPlan(project.id, text);
        setProject(updated);
        if (updated.pendingPlan) {
          say("agent", updated.pendingPlan.summary + "\nReview the plan below and apply it if it looks right.");
        } else {
          say("agent", "I couldn't derive any edits from that. Try one of the suggestions.");
        }
      } catch (error) {
        say("error", error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [project, say],
  );

  const onApply = useCallback(async () => {
    if (!project) return;
    setBusy("Applying plan to the timeline…");
    try {
      const updated = await applyPlan(project.id);
      setProject(updated);
      say("agent", "Applied. The edit is non-destructive — you can undo it any time.");
    } catch (error) {
      say("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [project, say]);

  const onDiscard = useCallback(async () => {
    if (!project) return;
    setProject(await discardPlan(project.id));
  }, [project]);

  const onUndo = useCallback(async () => {
    if (!project) return;
    setProject(await undo(project.id));
    say("agent", "Reverted the last edit.");
  }, [project, say]);

  const onRedo = useCallback(async () => {
    if (!project) return;
    setProject(await redo(project.id));
  }, [project]);

  const onExport = useCallback(async () => {
    if (!project) return;
    setBusy("Rendering export with FFmpeg…");
    try {
      const jobId = await startExport(project.id);
      const job = await waitForJob(jobId);
      if (job.status === "failed") throw new Error(job.error ?? "Export failed");
      const updated = await (await fetch(`/api/projects/${project.id}`, { cache: "no-store" })).json();
      setProject(updated as ProjectDTO);
      setOutputVersion((v) => v + 1);
      say("agent", "Export complete. Preview the result and download it below.");
    } catch (error) {
      say("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [project, say]);

  const sourceStrip = useMemo<StripItem[]>(() => {
    if (!project) return [];
    const total = project.source.durationMs || 1;
    return (project.analysis?.silences ?? []).map((s) => ({
      kind: "silence",
      leftPct: (s.startMs / total) * 100,
      widthPct: ((s.endMs - s.startMs) / total) * 100,
      title: `Pause ${formatMs(s.startMs)}–${formatMs(s.endMs)}`,
    }));
  }, [project]);

  const editedStrip = useMemo<StripItem[]>(() => {
    if (!project) return [];
    const total = project.timeline.durationMs || 1;
    let cursor = 0;
    return project.timeline.clips.map((clip) => {
      const leftPct = (cursor / total) * 100;
      const widthPct = (clip.outputDurationMs / total) * 100;
      cursor += clip.outputDurationMs;
      return {
        kind: clip.speed !== 1 ? "speed" : "keep",
        leftPct,
        widthPct,
        title:
          `Clip ${formatMs(clip.sourceInMs)}–${formatMs(clip.sourceOutMs)}` +
          (clip.speed !== 1 ? ` @ ${clip.speed}x` : ""),
      };
    });
  }, [project]);

  const removedMs = project
    ? Math.max(0, project.source.durationMs - project.timeline.durationMs)
    : 0;

  return (
    <div className="app">
      <header className="brand">
        <h1>CUTOS</h1>
        <span className="tag">agent-first conversational video editor</span>
        {project && <span className="badge">provider: {project.provider}</span>}
      </header>

      {!project && (
        <section className="card">
          <h2>Import a video</h2>
          <p className="muted">
            Start from a generated demo clip (with built-in pauses) or upload your own video. CUTOS
            analyzes the audio, then edits by natural language — every change is validated,
            non-destructive and reversible.
          </p>
          <div className="row">
            <button className="btn btn-primary" onClick={importSample} disabled={busy !== null}>
              {busy ? <span className="spinner" /> : "Load demo clip"}
            </button>
            <button
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy !== null}
            >
              Upload a video…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              hidden
              onChange={importUpload}
            />
          </div>
          {busy && <p className="muted" style={{ marginTop: 12 }}>{busy}</p>}
        </section>
      )}

      {project && (
        <>
          <section className="card">
            <h2>Preview — original source (immutable)</h2>
            <video className="player" src={`/api/projects/${project.id}/source`} controls />
            <div className="stat" style={{ marginTop: 14 }}>
              <div>
                <b>{formatSeconds(project.source.durationMs)}</b>
                <span>source duration</span>
              </div>
              <div>
                <b>{formatSeconds(project.timeline.durationMs)}</b>
                <span>edited duration</span>
              </div>
              <div>
                <b>{formatSeconds(removedMs)}</b>
                <span>removed</span>
              </div>
              <div>
                <b>{project.timeline.clips.length}</b>
                <span>clips</span>
              </div>
              <div>
                <b>{project.analysis?.silences.length ?? 0}</b>
                <span>pauses found</span>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Timeline</h2>
            <p className="muted" style={{ marginTop: 0 }}>Source with detected pauses</p>
            <Strip
              items={[
                { kind: "keep", leftPct: 0, widthPct: 100, title: "source" },
                ...sourceStrip,
              ]}
            />
            <p className="muted" style={{ marginBottom: 0, marginTop: 16 }}>Edited timeline</p>
            <Strip items={editedStrip} />
            <div className="legend">
              <span><i className="swatch" style={{ background: "#2563eb" }} /> kept</span>
              <span><i className="swatch" style={{ background: "#7c3aed" }} /> speed-changed</span>
              <span>
                <i
                  className="swatch"
                  style={{ background: "repeating-linear-gradient(45deg,#f8717188,#f8717188 4px,transparent 4px,transparent 8px)" }}
                />{" "}
                pause (to remove)
              </span>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn" onClick={onUndo} disabled={!project.canUndo || busy !== null}>
                Undo
              </button>
              <button className="btn" onClick={onRedo} disabled={!project.canRedo || busy !== null}>
                Redo
              </button>
            </div>
          </section>

          <section className="card chat">
            <h2>Agent</h2>
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.text}
              </div>
            ))}

            {project.pendingPlan && (
              <div className="review">
                <div>
                  <strong>Proposed Edit Plan</strong>{" "}
                  <span className="pill">{project.pendingPlan.operations.length} operations</span>
                </div>
                <ul className="oplist">
                  {project.pendingPlan.operations.map((op, i) => (
                    <li key={i}>
                      <span className="pill">{op.type}</span>
                      <span>
                        {formatMs(op.startMs)}–{formatMs(op.endMs)}
                        {op.speed ? ` · ${op.speed}x` : ""}
                        {op.reason ? ` · ${op.reason}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button className="btn btn-success" onClick={onApply} disabled={busy !== null}>
                    Apply plan
                  </button>
                  <button className="btn btn-ghost" onClick={onDiscard} disabled={busy !== null}>
                    Discard
                  </button>
                </div>
              </div>
            )}

            {busy && (
              <div className="msg agent">
                <span className="spinner" /> {busy}
              </div>
            )}

            <div className="composer">
              <input
                value={instruction}
                placeholder="Describe an edit…"
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitInstruction(instruction);
                }}
                disabled={busy !== null}
              />
              <button
                className="btn btn-primary"
                onClick={() => void submitInstruction(instruction)}
                disabled={busy !== null || !instruction.trim()}
              >
                Send
              </button>
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => void submitInstruction(s)} disabled={busy !== null}>
                  {s}
                </button>
              ))}
            </div>
          </section>

          <section className="grid two">
            <div className="card">
              <h2>Edit history</h2>
              {project.appliedPlans.length === 0 ? (
                <p className="muted">No edits applied yet.</p>
              ) : (
                project.appliedPlans.map((p, i) => (
                  <div key={p.id} className="history-item">
                    <span>
                      {i + 1}. {p.summary}
                    </span>
                    <span className="pill">{p.operationCount} ops</span>
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <h2>Export</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Deterministic FFmpeg render of the current timeline.
              </p>
              <button className="btn btn-primary" onClick={onExport} disabled={busy !== null}>
                {busy === "Rendering export with FFmpeg…" ? <span className="spinner" /> : "Export video"}
              </button>
              {project.output && (
                <div style={{ marginTop: 14 }}>
                  <video
                    key={outputVersion}
                    className="player"
                    src={`/api/projects/${project.id}/output?v=${outputVersion}`}
                    controls
                  />
                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="badge">rendered {formatSeconds(project.output.durationMs)}</span>
                    <a
                      className="btn"
                      href={`/api/projects/${project.id}/output?v=${outputVersion}`}
                      download="cutos-export.mp4"
                    >
                      Download
                    </a>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
