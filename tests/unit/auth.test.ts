import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const XDG = mkdtempSync(path.join(os.tmpdir(), "auth-xdg-"))
const AUTH_FILE = path.join(XDG, "opencode", "auth.json")
const CONFIG_XDG = mkdtempSync(path.join(os.tmpdir(), "auth-cfg-"))
const CONFIG_FILE = path.join(CONFIG_XDG, "opencode", "opencode.jsonc")
mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
const CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), "auth-codex-"))
const CODEX_AUTH_FILE = path.join(CODEX_HOME, "auth.json")

// Capture so this file's env edits don't leak into other test files sharing the Bun process;
// the E2E launchers spawn opencode with ...process.env.
const ORIGINAL_XDG_DATA_HOME = process.env.XDG_DATA_HOME
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const ORIGINAL_AUTH_PROVIDER = process.env.GPT_IMAGEGEN_AUTH_PROVIDER
const ORIGINAL_OMNIROUTE_BASE_URL = process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL
const ORIGINAL_OMNIROUTE_MODEL = process.env.GPT_IMAGEGEN_OMNIROUTE_MODEL
const ORIGINAL_OMNIROUTE_API_KEY = process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY
let loadOpenAIAuth: typeof import("../../src/auth").loadOpenAIAuth
let loadOmniRouteAuth: typeof import("../../src/auth").loadOmniRouteAuth
let normalizeOmniRouteBaseURL: typeof import("../../src/auth").normalizeOmniRouteBaseURL
let resolveImageProvider: typeof import("../../src/auth").resolveImageProvider

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeAll(async () => {
  // xdg-basedir captures XDG_DATA_HOME at import, so point it at the temp dir before
  // importing the module under test (which transitively imports xdg-basedir).
  process.env.XDG_DATA_HOME = XDG
  process.env.XDG_CONFIG_HOME = CONFIG_XDG
  process.env.CODEX_HOME = CODEX_HOME
  const auth = await import("../../src/auth")
  loadOpenAIAuth = auth.loadOpenAIAuth
  loadOmniRouteAuth = auth.loadOmniRouteAuth
  normalizeOmniRouteBaseURL = auth.normalizeOmniRouteBaseURL
  resolveImageProvider = auth.resolveImageProvider
})

afterAll(() => {
  restoreEnv("XDG_DATA_HOME", ORIGINAL_XDG_DATA_HOME)
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME)
  restoreEnv("CODEX_HOME", ORIGINAL_CODEX_HOME)
  restoreEnv("OPENCODE_AUTH_CONTENT", ORIGINAL_AUTH_CONTENT)
  restoreEnv("GPT_IMAGEGEN_AUTH_PROVIDER", ORIGINAL_AUTH_PROVIDER)
  restoreEnv("GPT_IMAGEGEN_OMNIROUTE_BASE_URL", ORIGINAL_OMNIROUTE_BASE_URL)
  restoreEnv("GPT_IMAGEGEN_OMNIROUTE_MODEL", ORIGINAL_OMNIROUTE_MODEL)
  restoreEnv("GPT_IMAGEGEN_OMNIROUTE_API_KEY", ORIGINAL_OMNIROUTE_API_KEY)
})

function writeAuthFile(content: string): void {
  writeFileSync(AUTH_FILE, content)
}

function writeConfigFile(content: string): void {
  writeFileSync(CONFIG_FILE, content)
}

function writeCodexAuthFile(tokens: Record<string, unknown>): void {
  writeFileSync(CODEX_AUTH_FILE, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens }))
}

function jwtExpiringIn(seconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")
  return `e30.${payload}.sig`
}

beforeEach(() => {
  delete process.env.OPENCODE_AUTH_CONTENT
  delete process.env.GPT_IMAGEGEN_AUTH_PROVIDER
  delete process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL
  delete process.env.GPT_IMAGEGEN_OMNIROUTE_MODEL
  delete process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY
  // Start each test from a no-credentials baseline; tests opt in to a file.
  writeAuthFile("{}")
  writeConfigFile("{}")
  rmSync(CODEX_AUTH_FILE, { force: true })
})

afterEach(() => {
  delete process.env.OPENCODE_AUTH_CONTENT
  delete process.env.GPT_IMAGEGEN_AUTH_PROVIDER
  delete process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL
  delete process.env.GPT_IMAGEGEN_OMNIROUTE_MODEL
  delete process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY
})

describe("loadOpenAIAuth", () => {
  test("reads a valid oauth entry from OPENCODE_AUTH_CONTENT", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "tok-env", accountId: "acct-1" },
    })
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-env", accountId: "acct-1" })
  })

  test("prefers OPENCODE_AUTH_CONTENT over the auth.json file", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok-env" } })
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-env" })
  })

  test("falls back to the auth.json file when the env var is unset", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-file" })
  })

  test("returns undefined when the entry is not an oauth type", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", access: "tok" } })
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when access is not a string", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: 123 } })
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when there is no openai entry", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ anthropic: { type: "oauth", access: "tok" } })
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when the content is not valid JSON", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("returns undefined when the auth.json file is missing", async () => {
    rmSync(AUTH_FILE, { force: true })
    // The read rejects; loadOpenAIAuth swallows it and reports no credentials.
    expect(await loadOpenAIAuth()).toBeUndefined()
  })

  test("falls back to the Codex CLI login when OpenCode has no openai entry", async () => {
    writeCodexAuthFile({ access_token: "tok-codex", account_id: "acct-codex", refresh_token: "r" })
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-codex", accountId: "acct-codex" })
  })

  test("prefers the OpenCode login over the Codex CLI login", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    writeCodexAuthFile({ access_token: "tok-codex" })
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: "tok-file" })
  })

  test("skips an expired OpenCode token in favor of an unexpired Codex CLI token", async () => {
    const fresh = jwtExpiringIn(3600)
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: jwtExpiringIn(-60) } }))
    writeCodexAuthFile({ access_token: fresh })
    expect(await loadOpenAIAuth()).toEqual({ type: "oauth", access: fresh })
  })

  test("returns undefined when every available token is expired", async () => {
    writeAuthFile(JSON.stringify({ openai: { type: "oauth", access: jwtExpiringIn(-60) } }))
    writeCodexAuthFile({ access_token: jwtExpiringIn(-60) })
    expect(await loadOpenAIAuth()).toBeUndefined()
  })
})

describe("loadOmniRouteAuth", () => {
  test("API key and base URL env vars override OpenCode config", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "auth-key" } })
    writeConfigFile(JSON.stringify({ provider: { omniroute: { options: { baseURL: "https://cfg.example/v1" } } } }))
    process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY = "env-key"
    process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL = "https://env.example"

    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "env-key",
      baseURL: "https://env.example/v1",
      model: "codex/gpt-6.1-sol",
    })
  })

  test("empty API key and base URL env vars fall back to OpenCode config", async () => {
    // Claude Code passes unconfigured plugin options as empty strings.
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "auth-key" } })
    process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY = ""
    process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL = ""

    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "auth-key",
      baseURL: "http://localhost:20128/v1",
      model: "codex/gpt-6.1-sol",
    })
  })

  test("reads an API-key entry from OpenCode auth data", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "omni-key" } })
    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "omni-key",
      baseURL: "http://localhost:20128/v1",
      model: "codex/gpt-6.1-sol",
    })
  })

  test("reads API key and base URL from standard provider options", async () => {
    writeConfigFile(
      JSON.stringify({
        provider: { omniroute: { options: { apiKey: "cfg-key", baseURL: "https://llm.example/v1/" } } },
      }),
    )

    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "cfg-key",
      baseURL: "https://llm.example/v1",
      model: "codex/gpt-6.1-sol",
    })
  })

  test("reads base URL from an OmniRoute wrapper plugin entry", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "auth-key" } })
    writeConfigFile(
      JSON.stringify({
        plugin: [
          {
            path: "./plugins/omniroute-wrapper.ts",
            options: { providerId: "omniroute", baseURL: "https://llm.example" },
          },
        ],
      }),
    )

    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "auth-key",
      baseURL: "https://llm.example/v1",
      model: "codex/gpt-6.1-sol",
    })
  })

  test("reads native V2 provider settings before legacy provider options", async () => {
    writeConfigFile(
      JSON.stringify({
        providers: { omniroute: { settings: { apiKey: "v2-key", baseURL: "https://v2.example" } } },
        provider: { omniroute: { options: { apiKey: "v1-key", baseURL: "https://v1.example" } } },
      }),
    )
    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "v2-key",
      baseURL: "https://v2.example/v1",
      model: "codex/gpt-6.1-sol",
    })
  })

  test("reads native V2 wrapper package options", async () => {
    writeConfigFile(
      JSON.stringify({
        plugins: [
          {
            package: "./plugins/omniroute-wrapper.ts",
            options: { apiKey: "wrapper-key", baseURL: "https://v2.example" },
          },
        ],
      }),
    )
    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "wrapper-key",
      baseURL: "https://v2.example/v1",
      model: "codex/gpt-6.1-sol",
    })
  })

  test("env base URL and model override config defaults", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "auth-key" } })
    process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL = "https://env.example/api/v1"
    process.env.GPT_IMAGEGEN_OMNIROUTE_MODEL = "image-model"

    expect(await loadOmniRouteAuth()).toEqual({
      type: "api",
      key: "auth-key",
      baseURL: "https://env.example/api/v1",
      model: "image-model",
    })
  })

  test("uses the default model for a blank override", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "auth-key" } })
    process.env.GPT_IMAGEGEN_OMNIROUTE_MODEL = "  "

    expect((await loadOmniRouteAuth())?.model).toBe("codex/gpt-6.1-sol")
  })

  test("normalizes base URLs without duplicate /v1", () => {
    expect(normalizeOmniRouteBaseURL("https://llm.example")).toBe("https://llm.example/v1")
    expect(normalizeOmniRouteBaseURL("https://llm.example/v1/")).toBe("https://llm.example/v1")
    expect(normalizeOmniRouteBaseURL("https://llm.example/v1/v1")).toBe("https://llm.example/v1")
  })
})

describe("resolveImageProvider", () => {
  test("auto chooses Codex when both Codex and OmniRoute auth are present", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "codex-token" },
      omniroute: { type: "api", key: "omni-key" },
    })

    expect(await resolveImageProvider()).toEqual({ kind: "codex", auth: { type: "oauth", access: "codex-token" } })
  })

  test("auto falls back to OmniRoute when Codex OAuth is absent", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "omni-key" } })

    expect(await resolveImageProvider()).toEqual({
      kind: "omniroute",
      auth: { type: "api", key: "omni-key", baseURL: "http://localhost:20128/v1", model: "codex/gpt-6.1-sol" },
    })
  })

  test("forced Codex ignores OmniRoute and fails when Codex OAuth is absent", async () => {
    process.env.GPT_IMAGEGEN_AUTH_PROVIDER = "codex"
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ omniroute: { type: "api", key: "omni-key" } })

    expect(resolveImageProvider()).rejects.toThrow(
      "Codex provider requested, but no unexpired ChatGPT OAuth credentials were found in OpenCode or Codex CLI auth.",
    )
  })

  test("forced OmniRoute ignores Codex and selects OmniRoute when available", async () => {
    process.env.GPT_IMAGEGEN_AUTH_PROVIDER = "omniroute"
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "codex-token" },
      omniroute: { type: "api", key: "omni-key" },
    })

    expect(await resolveImageProvider()).toEqual({
      kind: "omniroute",
      auth: { type: "api", key: "omni-key", baseURL: "http://localhost:20128/v1", model: "codex/gpt-6.1-sol" },
    })
  })

  test("invalid provider mode fails clearly", async () => {
    process.env.GPT_IMAGEGEN_AUTH_PROVIDER = "bogus"
    expect(resolveImageProvider()).rejects.toThrow(
      "Invalid GPT_IMAGEGEN_AUTH_PROVIDER. Expected one of: auto, codex, omniroute.",
    )
  })
})
