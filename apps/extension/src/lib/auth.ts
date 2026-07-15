const SERVER_BASE_URL = "http://127.0.0.1:8765"
const AUTH_SECRET_STORAGE_KEY = "kibitzer.localApiSecret"
const PAIR_REQUEST_CONTEXT = "kibitzer-pair-request-v1"
const PAIR_WRAP_CONTEXT = "kibitzer-pair-wrap-v1"
const PAIR_RESPONSE_CONTEXT = "kibitzer-pair-response-v1"
const REQUEST_CONTEXT = "kibitzer-request-v1"
const RESPONSE_CONTEXT = "kibitzer-response-v1"
const LOCATION_CONTEXT = "kibitzer-location-v1"
const HEX_64 = /^[0-9a-f]{64}$/

export interface AuthStatus {
  enabled: boolean
  paired: boolean
}

export async function getAuthStatus(): Promise<AuthStatus | null> {
  const response = await fetch(`${SERVER_BASE_URL}/auth/status`).catch(() => null)
  if (!response?.ok) return null
  try {
    const value = (await response.json()) as Partial<AuthStatus>
    if (typeof value.enabled !== "boolean" || typeof value.paired !== "boolean") return null
    return { enabled: value.enabled, paired: value.paired }
  } catch {
    return null
  }
}

export async function hasClientAuthSecret(): Promise<boolean> {
  return (await loadSecret()) !== null
}

export async function restrictAuthStorageToExtension(): Promise<void> {
  if (typeof chrome.storage.local.setAccessLevel !== "function") return
  await chrome.storage.local
    .setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_CONTEXTS })
    .catch(() => undefined)
}

export async function privateLocationId(location: string): Promise<string | null> {
  const secret = await loadSecret()
  if (!secret) return null
  return bytesToHex(await hmacSha256(secret, `${LOCATION_CONTEXT}\n${location}`))
}

export async function pairWithServer(rawCode: string): Promise<boolean> {
  const code = rawCode.trim().toLowerCase()
  if (!HEX_64.test(code)) return false

  const pairKey = await sha256(new TextEncoder().encode(code))
  const clientNonce = randomHex(16)
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const mask = await hmacSha256(pairKey, `${PAIR_WRAP_CONTEXT}\n${clientNonce}`)
  const wrapped = new Uint8Array(32)
  for (let index = 0; index < wrapped.length; index += 1) {
    wrapped[index] = secret[index] ^ mask[index]
  }
  const wrappedHex = bytesToHex(wrapped)
  const tag = bytesToHex(
    await hmacSha256(pairKey, `${PAIR_REQUEST_CONTEXT}\n${clientNonce}\n${wrappedHex}`),
  )

  const response = await fetch(`${SERVER_BASE_URL}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_nonce: clientNonce, wrapped_secret: wrappedHex, tag }),
  }).catch(() => null)
  if (!response?.ok) return false
  try {
    const body = (await response.json()) as { paired?: unknown; proof?: unknown }
    if (body.paired !== true || typeof body.proof !== "string") return false
    const expected = bytesToHex(
      await hmacSha256(secret, `${PAIR_RESPONSE_CONTEXT}\n${clientNonce}`),
    )
    if (!constantTimeEqual(expected, body.proof)) return false
    await restrictAuthStorageToExtension()
    await chrome.storage.local.set({ [AUTH_SECRET_STORAGE_KEY]: bytesToHex(secret) })
    return true
  } catch {
    return false
  }
}

export async function authenticatedFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const secret = await loadSecret()
  if (!secret) return null
  if (init.body !== undefined && typeof init.body !== "string") return null

  const url = new URL(input)
  const method = (init.method ?? "GET").toUpperCase()
  const body = init.body ?? ""
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomHex(16)
  const bodyHash = bytesToHex(await sha256(new TextEncoder().encode(body)))
  const canonical = `${REQUEST_CONTEXT}\n${timestamp}\n${nonce}\n${method}\n${url.pathname}${url.search}\n${bodyHash}`
  const signature = bytesToHex(await hmacSha256(secret, canonical))
  const headers = new Headers(init.headers)
  headers.set("x-kibitzer-timestamp", timestamp)
  headers.set("x-kibitzer-nonce", nonce)
  headers.set("x-kibitzer-signature", signature)

  const response = await fetch(input, { ...init, method, headers }).catch(() => null)
  if (!response) return null
  try {
    const responseBody = new Uint8Array(await response.clone().arrayBuffer())
    const responseHash = bytesToHex(await sha256(responseBody))
    const expected = bytesToHex(
      await hmacSha256(secret, `${RESPONSE_CONTEXT}\n${nonce}\n${response.status}\n${responseHash}`),
    )
    const actual = response.headers.get("x-kibitzer-response-proof") ?? ""
    return constantTimeEqual(expected, actual) ? response : null
  } catch {
    return null
  }
}

async function loadSecret(): Promise<Uint8Array | null> {
  try {
    const stored = await chrome.storage.local.get(AUTH_SECRET_STORAGE_KEY)
    const value = stored[AUTH_SECRET_STORAGE_KEY]
    if (typeof value !== "string" || !HEX_64.test(value)) return null
    return hexToBytes(value)
  } catch {
    return null
  }
}

function randomHex(length: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(length)))
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const bytes = Uint8Array.from(value)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer))
}

async function hmacSha256(key: Uint8Array, value: string): Promise<Uint8Array> {
  const keyBytes = Uint8Array.from(key)
  const valueBytes = new TextEncoder().encode(value)
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, valueBytes.buffer))
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(value: string): Uint8Array {
  return new Uint8Array(value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [])
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
