import { zhTW, type MessageKey } from "./zh-TW.js";

export type { MessageKey };

const LOCALES = { "zh-TW": zhTW } as const;
export type Locale = keyof typeof LOCALES;
export const DEFAULT_LOCALE: Locale = "zh-TW";

export type TParams = Record<string, string | number>;

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  );
}

/**
 * Translate a stable key into the current locale's copy. Missing keys fall back
 * to the key itself (surfaced by tests) rather than crashing the UI.
 */
export function translate(locale: Locale, key: MessageKey, params?: TParams): string {
  const dict = LOCALES[locale] as Record<string, string>;
  const template = dict[key] ?? (LOCALES[DEFAULT_LOCALE] as Record<string, string>)[key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

/** The app is single-locale (zh-TW) for now; the signature is locale-ready. */
export function t(key: MessageKey, params?: TParams): string {
  return translate(DEFAULT_LOCALE, key, params);
}

const ERROR_PREFIX = "error." as const;

/** Map a backend AppErrorCode to zh-TW copy (falls back to a generic message). */
export function errorMessage(code: string | undefined): string {
  const key = `${ERROR_PREFIX}${code ?? "UNKNOWN"}` as MessageKey;
  const message = translate(DEFAULT_LOCALE, key);
  return message === key ? t("error.UNKNOWN") : message;
}

/** Localized label for an agent activity step kind. */
export function activityLabel(kind: string): string {
  const key = `activity.${kind}` as MessageKey;
  const label = translate(DEFAULT_LOCALE, key);
  return label === key ? kind : label;
}

/** Localized label for an Edit DSL operation type (schema stays English). */
export function operationLabel(type: string): string {
  const key = `op.${type}` as MessageKey;
  const label = translate(DEFAULT_LOCALE, key);
  return label === key ? type : label;
}
