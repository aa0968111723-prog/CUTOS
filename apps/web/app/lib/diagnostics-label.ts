import { translate, DEFAULT_LOCALE, type MessageKey } from "../i18n/index.js";
import type { CheckStatusDTO } from "./types.js";

/**
 * Human-readable name for a subsystem.
 *
 * Falls back to the raw name rather than to a generic placeholder: a check this
 * build has no copy for is a check added by a newer server, and showing
 * `ffprobe` is far more useful to whoever is debugging than 「未知項目」.
 */
export function subsystemLabel(name: string): string {
  const key = `status.name.${name}` as MessageKey;
  const label = translate(DEFAULT_LOCALE, key);
  return label === key ? name : label;
}

/** Localized word for a check's state. */
export function statusLabel(status: CheckStatusDTO): string {
  const key = `status.check.${status}` as MessageKey;
  const label = translate(DEFAULT_LOCALE, key);
  return label === key ? status : label;
}

/** Overall-state headline for the panel. */
export function overallLabel(status: CheckStatusDTO): string {
  const key = `status.overall.${status}` as MessageKey;
  const label = translate(DEFAULT_LOCALE, key);
  return label === key ? status : label;
}
