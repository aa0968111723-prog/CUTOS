/**
 * Interpreting a project's media status — deliberately fail-open.
 *
 * The workspace gate used to be `mediaStatus === "ready"`, which locks the user
 * out of their own project for ANY value that is not exactly that string:
 * a status this build does not know, a field missing from an older or cached
 * response, `undefined` after a partial deploy — and, worst of all, a probe
 * that failed on media the browser could have played perfectly well.
 *
 * So the predicates below only ever recognise the states we positively know are
 * not ready. Everything else is treated as ready. Showing a working project
 * that turns out to be still processing is a small, self-correcting annoyance;
 * hiding a working project behind a dead-end panel is not.
 */
import type { MediaStatusDTO } from "./types.js";

type Status = MediaStatusDTO | string | null | undefined;

/** The media is stored but its metadata has not been read yet. */
export function isMediaPending(status: Status): boolean {
  return status === "uploaded" || status === "probing";
}

/** The media is stored but could not be read. Retryable, never fatal. */
export function isMediaFailed(status: Status): boolean {
  return status === "failed";
}

/**
 * Whether the workspace can render normally.
 *
 * Note the asymmetry: this is `!pending && !failed`, NOT `=== "ready"`. An
 * unrecognised status resolves to `true` on purpose — see the module docstring.
 */
export function isMediaReady(status: Status): boolean {
  return !isMediaPending(status) && !isMediaFailed(status);
}

/**
 * Whether the project still needs watching. A pending project changes state on
 * its own once the probe job finishes, so the UI has to keep asking.
 */
export function shouldPollMedia(status: Status): boolean {
  return isMediaPending(status);
}
