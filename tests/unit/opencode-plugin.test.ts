import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext as ToolContextV2, ToolEditor } from "@opencode/plugin/promise/tool"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import plugin from "../../src/index"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

const originalFetch = globalThis.fetch
const envKeys = [
  "OPENCODE_AUTH_CONTENT",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "GPT_IMAGEGEN_AUTH_PROVIDER",
  "GPT_IMAGEGEN_CODEX_MODEL",
  "GPT_IMAGEGEN_OMNIROUTE_API_KEY",
  "GPT_IMAGEGEN_OMNIROUTE_BASE_URL",
  "GPT_IMAGEGEN_OMNIROUTE_MODEL",
] as const
let originalEnv: Record<string, string | undefined>
let directory: string

beforeEach(async () => {
  originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  directory = await mkdtemp(path.join(os.tmpdir(), "imagegen-plugin-"))
  process.env.OPENCODE_AUTH_CONTENT = "{}"
  process.env.CODEX_HOME = directory
  process.env.XDG_CONFIG_HOME = directory
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  await rm(directory, { recursive: true, force: true })
})

function v2Context() {
  const tools: Info[] = []
  const transform = mock(async (callback: (editor: ToolEditor) => void) => {
    callback({ add: (definition: Info) => tools.push(definition) } as unknown as ToolEditor)
    return { dispose: async () => {} }
  })
  const active = mock(async (id: string) => ({ type: "env", name: id }))
  const resolve = mock(async (_connection: unknown): Promise<unknown> => undefined)
  const getProvider = mock(async (_input: unknown) => ({ data: { settings: { baseURL: "https://omni.example" } } }))
  const getSession = mock(async (_input: unknown) => ({ location: { directory } }))
  const ctx = {
    location: { directory: path.join(directory, "plugin-location") },
    tool: { transform },
    integration: { connection: { active, resolve } },
    provider: { get: getProvider },
    session: { get: getSession },
  } as unknown as Plugin.Context
  return { ctx, tools, transform, active, resolve, getProvider, getSession }
}

const invocation = { sessionID: "ses_test" } as ToolContextV2
const args = { prompt: "a cat", out: "cat.png", quality: "medium" as const }

test("V2 registers without resolving auth and uses fresh OAuth and the session directory on each call", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "old-file-token" } })
  const host = v2Context()
  let token = "v2-token"
  host.resolve.mockImplementation(async () => ({ type: "oauth", access: token, metadata: { accountID: "acct-v2" } }))
  const fetchMock = mock(
    async (_url: unknown, _init: RequestInit) =>
      new Response(
        `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: PNG_BASE64 } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  await plugin.setup(host.ctx)
  expect(host.transform).toHaveBeenCalledTimes(1)
  expect(host.active).not.toHaveBeenCalled()
  const tool = host.tools[0]
  expect(tool.name).toBe("gpt_imagegen")
  const result = await tool.execute(args, invocation)
  expect(result.content).toContain(path.join(directory, "cat.png"))
  expect(result.metadata).toEqual({
    out: path.join(directory, "cat.png"),
    versioned: false,
    provider: "codex",
    billing: "subscription",
  })
  expect(await readFile(path.join(directory, "cat.png"))).toEqual(PNG_BUFFER)
  expect(host.getSession).toHaveBeenCalledWith({ sessionID: "ses_test" })
  expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
    Authorization: "Bearer v2-token",
    "ChatGPT-Account-Id": "acct-v2",
  })

  token = "refreshed-token"
  const worktree = await mkdtemp(path.join(directory, "worktree-"))
  await writeFile(path.join(worktree, "cat.png"), PNG_BUFFER)
  host.getSession.mockImplementation(async () => ({ location: { directory: worktree } }))
  const next = await tool.execute({ ...args, images: ["cat.png"] }, invocation)
  expect(next.metadata?.versioned).toBe(true)
  expect(next.metadata?.out).toBe(path.join(worktree, "cat-v2.png"))
  expect(await readFile(path.join(worktree, "cat-v2.png"))).toEqual(PNG_BUFFER)
  expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ Authorization: "Bearer refreshed-token" })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).input[0].content[1]).toEqual({
    type: "input_image",
    image_url: `data:image/png;base64,${PNG_BASE64}`,
  })
})

test("V2 falls back from an API-key OpenAI connection to OmniRoute using live provider settings", async () => {
  const host = v2Context()
  host.resolve.mockImplementation(async (connection) => ({
    type: "key",
    key: (connection as { name: string }).name === "omniroute" ? "omni-v2-key" : "openai-api-key",
  }))
  const fetchMock = mock(async (_url: unknown, _init: RequestInit) =>
    Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await plugin.setup(host.ctx)
  const result = await host.tools[0].execute(args, invocation)
  expect(result.metadata?.provider).toBe("omniroute")
  expect(host.getProvider).toHaveBeenCalledWith({ providerID: "omniroute", location: { directory } })
  expect(fetchMock.mock.calls[0][0]).toBe("https://omni.example/v1/images/generations")
  expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer omni-v2-key" })
})

test("V2 honors forced OmniRoute and environment overrides before live credentials", async () => {
  process.env.GPT_IMAGEGEN_AUTH_PROVIDER = "omniroute"
  process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY = "env-key"
  process.env.GPT_IMAGEGEN_OMNIROUTE_BASE_URL = "https://env.example/v1"
  const host = v2Context()
  host.resolve.mockImplementation(async () => ({ type: "key", key: "live-key" }))
  const fetchMock = mock(async (_url: unknown, _init: RequestInit) =>
    Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await plugin.setup(host.ctx)
  await host.tools[0].execute(args, invocation)
  expect(host.active).toHaveBeenCalledTimes(1)
  expect(host.active).toHaveBeenCalledWith("omniroute")
  expect(fetchMock.mock.calls[0][0]).toBe("https://env.example/v1/images/generations")
  expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer env-key" })
})

test("V2 retains project provider settings when the mapped integration cannot resolve", async () => {
  process.env.GPT_IMAGEGEN_AUTH_PROVIDER = "omniroute"
  const host = v2Context()
  host.getProvider.mockImplementation(async () => ({
    data: { integrationID: "router-auth", settings: { baseURL: "https://project.example", apiKey: "project-key" } },
  }))
  host.resolve.mockImplementation(async () => {
    throw new Error("integration unavailable")
  })
  const fetchMock = mock(async (_url: unknown, _init: RequestInit) =>
    Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await plugin.setup(host.ctx)
  await host.tools[0].execute(args, invocation)
  expect(host.active).toHaveBeenCalledWith("router-auth")
  expect(fetchMock.mock.calls[0][0]).toBe("https://project.example/v1/images/generations")
  expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer project-key" })
})

test("V1 server still exposes a validated tool with output metadata", async () => {
  process.env.GPT_IMAGEGEN_AUTH_PROVIDER = "omniroute"
  process.env.GPT_IMAGEGEN_OMNIROUTE_API_KEY = "v1-key"
  globalThis.fetch = mock(async () => Response.json({ data: [{ b64_json: PNG_BASE64 }] })) as unknown as typeof fetch
  const hooks = await plugin.server({ directory } as PluginInput)
  const tool = hooks.tool?.gpt_imagegen
  expect(tool).toBeDefined()
  const { tool: helper } = await import("@opencode-ai/plugin")
  expect(tool && helper.schema.object(tool.args).safeParse({ ...args, quality: "invalid" }).success).toBe(false)
  await writeFile(path.join(directory, "cat.png"), PNG_BUFFER)
  const result = await tool?.execute(args, { directory } as ToolContext)
  expect(result).toMatchObject({
    output: expect.stringContaining("cat-v2.png"),
    metadata: { provider: "omniroute", versioned: true },
  })
  expect(await readFile(path.join(directory, "cat.png"))).toEqual(PNG_BUFFER)
})
