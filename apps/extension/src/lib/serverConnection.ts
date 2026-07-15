import {
  KIBITZER_PORT_CANDIDATES,
  KIBITZER_PROTOCOL_VERSION,
  KIBITZER_SERVICE,
} from "../generated/portCandidates.ts"

const CACHED_PORT_KEY = "kibitzer.serverPort.v1"
const PROBE_TIMEOUT_MS = 500

interface ServerIdentity {
  service?: unknown
  protocol_version?: unknown
  instance_id?: unknown
}

export async function discoverServerPort(): Promise<number | null> {
  const cachedPort = await readCachedPort()
  const ports = cachedPort === null
    ? [...KIBITZER_PORT_CANDIDATES]
    : [cachedPort, ...KIBITZER_PORT_CANDIDATES.filter((port) => port !== cachedPort)]

  for (const port of ports) {
    if (!(await probePort(port))) continue
    await chrome.storage.local.set({ [CACHED_PORT_KEY]: port }).catch(() => undefined)
    return port
  }
  await chrome.storage.local.remove(CACHED_PORT_KEY).catch(() => undefined)
  return null
}

let effectivePortPromise: Promise<number | null> | null = null

async function effectivePort(): Promise<number | null> {
  effectivePortPromise ??= discoverServerPort()
  const port = await effectivePortPromise
  if (port === null) effectivePortPromise = null
  return port
}

export async function serverFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const port = await effectivePort()
  if (port === null) return null
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init).catch(() => null)
  if (!response) effectivePortPromise = null
  return response
}

async function readCachedPort(): Promise<number | null> {
  const stored = await chrome.storage.local.get(CACHED_PORT_KEY).catch(
    () => ({}),
  ) as Record<string, unknown>
  const port = stored[CACHED_PORT_KEY]
  return typeof port === "number" && KIBITZER_PORT_CANDIDATES.some((candidate) => candidate === port)
    ? port
    : null
}

async function probePort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/identity`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const identity = (await response.json()) as ServerIdentity
    return (
      identity.service === KIBITZER_SERVICE &&
      identity.protocol_version === KIBITZER_PROTOCOL_VERSION &&
      typeof identity.instance_id === "string" &&
      identity.instance_id.length > 0
    )
  } catch {
    return false
  }
}
