import { klog } from "../lib/klog.ts"
import { ProviderResponseError, type ProviderResponseStage } from "./errors.ts"
import { truncateCodePoints } from "./judgeParsing.ts"

const rawResponses = new WeakMap<Record<string, unknown>, string>()

// Entries live in chrome.storage.local (10MB, no unlimitedStorage) and are exported through
// a data: URL, so an oversized body must not go in verbatim. The http_json stage is the real
// risk: that body is a proxy/gateway page rather than bounded model output.
const RAW_LOG_LIMIT = 8000

function truncateForLog(rawResponse: string): string {
  // UTF-16 length >= code-point count, so this skips the scan for the common small body.
  if (rawResponse.length <= RAW_LOG_LIMIT) return rawResponse
  const kept = truncateCodePoints(rawResponse, RAW_LOG_LIMIT)
  return `${kept}… (truncated, ${rawResponse.length} chars total)`
}

function logRawResponse(
  context: string,
  stage: ProviderResponseStage,
  rawResponse: string,
): void {
  klog(`llm response raw (${context}, ${stage}): ${truncateForLog(rawResponse)}`)
}

/** Read and retain the HTTP body so a format failure can include the exact provider
 * response in the user-exported debug log. Request bodies and credentials are never
 * recorded here. */
export async function readProviderJson(
  response: Response,
  context: string,
): Promise<Record<string, unknown>> {
  const rawResponse = await response.text()
  let data: unknown
  try {
    data = JSON.parse(rawResponse)
  } catch {
    logRawResponse(context, "http_json", rawResponse)
    throw new ProviderResponseError("http_json", "provider HTTP body was not JSON")
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    logRawResponse(context, "envelope", rawResponse)
    throw new ProviderResponseError("envelope", "provider response was not a JSON object")
  }
  const record = data as Record<string, unknown>
  rawResponses.set(record, rawResponse)
  return record
}

/** Log the retained raw HTTP response only when response/content validation fails.
 * The safe ProviderResponseError itself remains free of raw model output because it
 * is also used by popup health diagnostics. */
export function withResponseDebug<T>(
  response: Record<string, unknown>,
  context: string,
  parse: () => T,
): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof ProviderResponseError) {
      const rawResponse = rawResponses.get(response) ?? JSON.stringify(response)
      logRawResponse(context, error.stage, rawResponse)
    }
    throw error
  }
}

/** Apply the same debug boundary when a provider method returns model text and a
 * higher-level parser validates it later (currently goal enrichment). */
export function withRawResponseDebug<T>(
  rawResponse: string,
  context: string,
  stage: ProviderResponseStage,
  parse: () => T,
): T {
  try {
    return parse()
  } catch (error) {
    logRawResponse(
      context,
      error instanceof ProviderResponseError ? error.stage : stage,
      rawResponse,
    )
    throw error
  }
}
