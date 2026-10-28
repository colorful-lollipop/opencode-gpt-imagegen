import { Buffer } from "node:buffer"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { xdgConfig, xdgData } from "xdg-basedir"
import type { ImageProvider, ImageProviderMode, OmniRouteAuth, OpenAIAuth } from "./types"

const DEFAULT_OMNIROUTE_BASE_URL = "http://localhost:20128/v1"
const DEFAULT_OMNIROUTE_MODEL = "codex/gpt-6.1-sol"

// V2 exposes resolved credentials through the plugin context instead of auth.json.
export type AuthSources = {
  openai?: () => Promise<OpenAIAuth | undefined>
  omniroute?: () => Promise<{ key?: string; baseURL?: string } | undefined>
}

// Legacy OpenCode/MCP fallback: OPENCODE_AUTH_CONTENT overrides $XDG_DATA_HOME/opencode/auth.json.
async function loadAuthData(): Promise<Record<string, unknown>> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
  }
  const dataHome = process.env.XDG_DATA_HOME ?? xdgData
  if (!dataHome) {
    throw new Error("could not determine XDG data directory")
  }
  const raw = await fs.readFile(path.join(dataHome, "opencode", "auth.json"), "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stripJsonComments(input: string): string {
  let output = ""
  let inString = false
  let quote = ""
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    const next = input[i + 1]

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        inString = false
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      output += char
      continue
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++
      output += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i++
      continue
    }

    output += char
  }

  return output
}

function parseJsonc(raw: string): Record<string, unknown> {
  return JSON.parse(stripJsonComments(raw).replace(/,\s*([}\]])/g, "$1")) as Record<string, unknown>
}

async function loadOpenCodeConfig(): Promise<Record<string, unknown> | undefined> {
  const configHome = process.env.XDG_CONFIG_HOME ?? xdgConfig
  if (!configHome) return undefined

  for (const fileName of ["opencode.jsonc", "opencode.json"]) {
    try {
      const raw = await fs.readFile(path.join(configHome, "opencode", fileName), "utf-8")
      return parseJsonc(raw)
    } catch {
      // Try the next supported config filename.
    }
  }

  return undefined
}

function getStandardOmniRouteOptions(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const providers = isRecord(config?.providers) ? config.providers : undefined
  const native = isRecord(providers?.omniroute) ? providers.omniroute : undefined
  if (isRecord(native?.settings)) return native.settings
  const provider = isRecord(config?.provider) ? config.provider : undefined
  const omniroute = isRecord(provider?.omniroute) ? provider.omniroute : undefined
  return isRecord(omniroute?.options) ? omniroute.options : undefined
}

function hasOmniRouteMarker(value: unknown): boolean {
  if (typeof value === "string") return value.toLowerCase().includes("omniroute")
  if (Array.isArray(value)) return value.some(hasOmniRouteMarker)
  if (!isRecord(value)) return false
  return Object.entries(value).some(
    ([key, entry]) => key.toLowerCase().includes("omniroute") || hasOmniRouteMarker(entry),
  )
}

function getOmniRouteWrapperOptions(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const plugins = Array.isArray(config?.plugins) ? config.plugins : config?.plugin
  if (!Array.isArray(plugins)) return undefined

  for (const plugin of plugins) {
    if (!hasOmniRouteMarker(plugin)) continue

    if (Array.isArray(plugin)) {
      for (const entry of plugin) {
        if (isRecord(entry) && (entry.providerId === "omniroute" || entry.baseURL || entry.apiKey)) return entry
        if (isRecord(entry) && isRecord(entry.options)) return entry.options
      }
    }

    if (isRecord(plugin)) {
      if (isRecord(plugin.options)) return plugin.options
      if (plugin.providerId === "omniroute" || plugin.baseURL || plugin.apiKey) return plugin
    }
  }

  return undefined
}

function getOmniRouteApiKeyFromAuth(data: Record<string, unknown> | undefined): string | undefined {
  const entry = isRecord(data?.omniroute) ? data.omniroute : undefined
  if (entry?.type !== "api") return undefined
  return stringValue(entry.key) ?? stringValue(entry.apiKey) ?? stringValue(entry.access) ?? stringValue(entry.token)
}

export function normalizeOmniRouteBaseURL(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error("OmniRoute base URL is empty")

  const url = new URL(trimmed)
  let pathname = url.pathname.replace(/\/+$/, "")
  pathname = pathname.replace(/\/images\/generations$/i, "")
  while (/\/v1\/v1$/i.test(pathname)) pathname = pathname.replace(/\/v1\/v1$/i, "/v1")
  if (!/\/v1$/i.test(pathname)) pathname = `${pathname}/v1`
  url.pathname = pathname
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/+$/, "")
}

async function loadOpenCodeOpenAIAuth(): Promise<OpenAIAuth | undefined> {
  const data = await loadAuthData()
  const entry = data.openai as Partial<OpenAIAuth> | undefined
  return entry?.type === "oauth" && typeof entry.access === "string" ? (entry as OpenAIAuth) : undefined
}

// Codex CLI keeps its ChatGPT login in $CODEX_HOME/auth.json (default ~/.codex).
async function loadCodexCliAuth(): Promise<OpenAIAuth | undefined> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  const data = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf-8")) as Record<string, unknown>
  const tokens = isRecord(data.tokens) ? data.tokens : undefined
  const access = stringValue(tokens?.access_token)
  if (!access) return undefined
  const accountId = stringValue(tokens?.account_id)
  return { type: "oauth", access, ...(accountId ? { accountId } : {}) }
}

// ChatGPT access tokens are JWTs that only OpenCode and Codex CLI refresh, and only while they run,
// so a stale copy is skipped instead of being sent to the backend to fail with 401.
function isExpiredJwt(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8")) as {
      exp?: unknown
    }
    return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()
  } catch {
    return false
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segments = token.split(".")
  if (segments.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf-8")) as unknown
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

// OpenCode V2 exposes ChatGPT "token sharing" credentials (method `chatgpt-token-sharing`)
// through the plugin context. Those tokens carry a `https://api.openai.com/auth` claim
// without `chatgpt_account_id`, and the Codex backend rejects them with
// 401 `rejected_by_access_enforcement / no_matching_rule`, so they must be skipped in favor
// of the Codex CLI login instead of being sent and failing the whole request.
function isCodexCapableOAuth(auth: OpenAIAuth): boolean {
  if (auth.accountId) return true

  const payload = decodeJwtPayload(auth.access)
  // Opaque or unparseable credentials are left to the backend, as before.
  if (!payload) return true

  const authClaim = payload["https://api.openai.com/auth"]
  // Tokens without the ChatGPT auth claim (older shapes, fixtures) are not judged here.
  if (!isRecord(authClaim)) return true

  return stringValue(authClaim.chatgpt_account_id) !== undefined
}

// OpenCode's login wins over Codex CLI's; expired or non-Codex-capable credentials are skipped.
export async function loadOpenAIAuth(source?: AuthSources["openai"]): Promise<OpenAIAuth | undefined> {
  const loaders = source
    ? [source, loadOpenCodeOpenAIAuth, loadCodexCliAuth]
    : [loadOpenCodeOpenAIAuth, loadCodexCliAuth]
  for (const load of loaders) {
    const auth = await load().catch(() => undefined)
    if (auth && !isExpiredJwt(auth.access) && isCodexCapableOAuth(auth)) return auth
  }
  return undefined
}

export async function loadOmniRouteAuth(source?: AuthSources["omniroute"]): Promise<OmniRouteAuth | undefined> {
  const resolved = await source?.().catch(() => undefined)
  const authData = await loadAuthData().catch(() => undefined)
  const config = await loadOpenCodeConfig()
  const standardOptions = getStandardOmniRouteOptions(config)
  const wrapperOptions = getOmniRouteWrapperOptions(config)

  // Empty env values count as unset: Claude Code passes unconfigured plugin options to the MCP server as "".
  const key =
    stringValue(process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY) ??
    stringValue(resolved?.key) ??
    getOmniRouteApiKeyFromAuth(authData) ??
    stringValue(standardOptions?.apiKey) ??
    stringValue(wrapperOptions?.apiKey)
  if (!key) return undefined

  const baseURL = normalizeOmniRouteBaseURL(
    stringValue(process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL) ??
      stringValue(resolved?.baseURL) ??
      stringValue(standardOptions?.baseURL) ??
      stringValue(wrapperOptions?.baseURL) ??
      DEFAULT_OMNIROUTE_BASE_URL,
  )
  const model = process.env.GPT_IMAGEGEN_OMNIROUTE_MODEL?.trim() || DEFAULT_OMNIROUTE_MODEL

  return { type: "api", key, baseURL, model }
}

function getImageProviderMode(): ImageProviderMode {
  const mode = process.env.GPT_IMAGEGEN_AUTH_PROVIDER ?? "auto"
  if (mode === "auto" || mode === "codex" || mode === "omniroute") return mode
  throw new Error("Invalid GPT_IMAGEGEN_AUTH_PROVIDER. Expected one of: auto, codex, omniroute.")
}

export async function resolveImageProvider(sources: AuthSources = {}): Promise<ImageProvider> {
  const mode = getImageProviderMode()

  if (mode === "auto" || mode === "codex") {
    const openai = await loadOpenAIAuth(sources.openai)
    if (openai) return { kind: "codex", auth: openai }
    if (mode === "codex") {
      throw new Error(
        "Codex provider requested, but no unexpired ChatGPT OAuth credentials were found in OpenCode or Codex CLI auth. " +
          "OpenCode V2 token-sharing credentials cannot call the Codex image backend; run `codex login` to provide a usable token.",
      )
    }
  }

  const omniroute = await loadOmniRouteAuth(sources.omniroute)
  if (omniroute) return { kind: "omniroute", auth: omniroute }
  if (mode === "omniroute") {
    throw new Error("OmniRoute provider requested, but OmniRoute API credentials are not configured.")
  }

  throw new Error(
    "No image provider credentials configured. Sign in with ChatGPT in OpenCode or Codex CLI (running either one refreshes an expired token), or configure OmniRoute API credentials. " +
      "If OpenCode is already signed in on V2, note that its token-sharing credential cannot call the Codex image backend; run `codex login` to add a usable token.",
  )
}
