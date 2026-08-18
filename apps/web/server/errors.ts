/** An error carrying an intended HTTP status code (framework-agnostic). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
