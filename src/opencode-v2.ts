import type { Plugin } from "@opencode/plugin"
import type { AuthSources } from "./auth"
import { ARG_DESCRIPTIONS, generateImage, QUALITY_VALUES, TOOL_DESCRIPTION } from "./generate"
import type { GenerateArgs } from "./types"

function authSources(ctx: Plugin.Context, directory: string): AuthSources {
  return {
    async openai() {
      const connection = await ctx.integration.connection.active("openai")
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (credential?.type !== "oauth" || !credential.access) return undefined
      const accountId = credential.metadata?.accountID
      return {
        type: "oauth",
        access: credential.access,
        ...(typeof accountId === "string" ? { accountId } : {}),
      }
    },
    async omniroute() {
      const provider = await ctx.provider
        .get({ providerID: "omniroute", location: { directory } })
        .catch(() => undefined)
      const connection = await ctx.integration.connection
        .active(provider?.data.integrationID ?? "omniroute")
        .catch(() => undefined)
      const credential = connection
        ? await ctx.integration.connection.resolve(connection).catch(() => undefined)
        : undefined
      const settings = provider?.data.settings
      const key = credential?.type === "key" ? credential.key : settings?.apiKey
      return {
        key: typeof key === "string" ? key : undefined,
        baseURL: typeof settings?.baseURL === "string" ? settings.baseURL : undefined,
      }
    },
  }
}

// Plugin.define is an identity helper. A typed definition keeps both host SDKs
// out of the module's runtime imports, so either OpenCode version can load it.
export const GptImagePluginV2 = {
  id: "opencode-gpt-imagegen",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "gpt_imagegen",
        description: TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: ARG_DESCRIPTIONS.prompt },
            out: { type: "string", description: ARG_DESCRIPTIONS.out },
            quality: { type: "string", enum: [...QUALITY_VALUES], description: ARG_DESCRIPTIONS.quality },
            size: { type: "string", description: ARG_DESCRIPTIONS.size },
            images: { type: "array", items: { type: "string" }, description: ARG_DESCRIPTIONS.images },
          },
          required: ["prompt", "out", "quality"],
          additionalProperties: false,
        },
        async execute(input, context) {
          // A session can move to another worktree after this plugin loads.
          const session = await ctx.session.get({ sessionID: context.sessionID })
          const { savedPath, versioned, message, provider } = await generateImage(
            input as GenerateArgs,
            session.location.directory,
            authSources(ctx, session.location.directory),
          )
          return {
            content: message,
            metadata: {
              out: savedPath,
              versioned,
              provider,
              billing: provider === "codex" ? "subscription" : "omniroute",
            },
          }
        },
      })
    })
  },
} satisfies Plugin.Plugin
