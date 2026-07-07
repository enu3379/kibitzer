#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ID = "8f46c685-8891-4c99-8d1e-999bbafe40c3"
const DEFAULT_BASE_URL = "http://127.0.0.1:19828/api/v1"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const RUN_DIR = path.join(ROOT, ".llm-wiki/runs/search")

function usage() {
  console.error("Usage: node scripts/llm-wiki-search.mjs <query> [top_k]")
  process.exit(2)
}

function safeStem(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "search"
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

function resultSummary(result) {
  return {
    path: result.path,
    title: result.title,
    score: result.score,
    mode: result.mode,
    snippet: result.snippet ? String(result.snippet).replace(/\s+/g, " ").slice(0, 500) : undefined,
  }
}

async function writeRunLog(payload) {
  await fs.promises.mkdir(RUN_DIR, { recursive: true })
  const timestamp = compactTimestamp()
  const fileName = `${timestamp}-${safeStem(payload.query)}.json`
  const filePath = path.join(RUN_DIR, fileName)
  await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  return filePath
}

const query = process.argv[2]
if (!query) usage()
const topK = Number.parseInt(process.argv[3] ?? "8", 10)

const statePath = path.join(os.homedir(), "Library/Application Support/com.llmwiki.app/app-state.json")
const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
const token = state.apiConfig?.token
if (!token) {
  console.error("LLM Wiki API token not found in app-state.json")
  process.exit(1)
}

const baseUrl = process.env.LLM_WIKI_API_BASE_URL ?? DEFAULT_BASE_URL
const response = await fetch(`${baseUrl}/projects/${encodeURIComponent(PROJECT_ID)}/search`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "X-LLM-Wiki-Token": token,
  },
  body: JSON.stringify({
    query,
    topK: Number.isFinite(topK) ? topK : 8,
    includeContent: false,
  }),
})

const body = await response.json()
if (!response.ok || body.ok === false) {
  await writeRunLog({
    command: "llm-wiki-search",
    ok: false,
    at: new Date().toISOString(),
    projectId: PROJECT_ID,
    baseUrl,
    query,
    topK,
    status: response.status,
    error: body,
  })
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

const logPath = await writeRunLog({
  command: "llm-wiki-search",
  ok: true,
  at: new Date().toISOString(),
  projectId: PROJECT_ID,
  baseUrl,
  query,
  topK,
  status: response.status,
  resultCount: body.results.length,
  results: body.results.map(resultSummary),
})

for (const [index, result] of body.results.entries()) {
  const score = typeof result.score === "number" ? result.score.toFixed(2) : "n/a"
  console.log(`${index + 1}. ${result.path} (${score})`)
  console.log(`   ${result.title}`)
  if (result.snippet) {
    console.log(`   ${String(result.snippet).replace(/\\s+/g, " ").slice(0, 220)}`)
  }
}
console.error(`Logged search run: ${logPath}`)
