export type ProviderResponseStage =
  | "http_json"
  | "envelope"
  | "content_json"
  | "schema"
  | "writer_empty"
  | "output_exhausted"

/**
 * A safe provider-response failure. Raw model output and credentials are
 * deliberately absent because these errors may reach extension diagnostics.
 */
export class ProviderResponseError extends Error {
  readonly stage: ProviderResponseStage

  constructor(stage: ProviderResponseStage, message: string) {
    super(message)
    this.name = "ProviderResponseError"
    this.stage = stage
  }
}

/** HTTP failure carrying only the status code, never the provider body. */
export class ProviderHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`provider HTTP request failed with status ${status}`)
    this.name = "ProviderHttpError"
    this.status = status
  }
}
