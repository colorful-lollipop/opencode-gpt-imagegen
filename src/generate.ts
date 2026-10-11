import { type AuthSources, resolveImageProvider } from "./auth"
import { callViaCodexResponses } from "./codex"
import { readReferenceImages } from "./input-image"
import { callViaOmniRoute } from "./omniroute"
import { saveGeneratedImage } from "./output-image"
import type { GenerateArgs } from "./types"

// Tool metadata shared by the OpenCode plugin and the MCP server; each host builds its own schema from it.
// https://developers.openai.com/api/docs/guides/image-generation
export const TOOL_DESCRIPTION = [
  "Generate raster images using Codex image_generation or OmniRoute image generation.",
  "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
  "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
  "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
  "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
  "Defaults to ChatGPT/Codex OAuth when available, then falls back to OmniRoute API credentials; set GPT_IMAGEGEN_AUTH_PROVIDER=codex or omniroute to force a path. Returns the absolute path of the saved PNG.",
].join(" ")

export const QUALITY_VALUES = ["low", "medium", "high", "auto"] as const

export const ARG_DESCRIPTIONS = {
  prompt: "Description of the image to generate.",
  out: "Output file path, relative to the project directory unless absolute. The plugin writes a PNG.",
  quality: "Requested generation quality. Codex OAuth forwards it best-effort; OmniRoute currently omits it.",
  size: "Optional requested image size forwarded to the selected backend. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400. Codex-backed providers may return auto-selected dimensions.",
  images: "Optional reference image paths, relative to the project directory unless absolute.",
}

export async function generateImage(args: GenerateArgs, directory: string, sources?: AuthSources) {
  const provider = await resolveImageProvider(sources)
  const inputImageDataUrls = await readReferenceImages(args.images, directory)
  const base64 =
    provider.kind === "codex"
      ? await callViaCodexResponses(provider.auth, args, inputImageDataUrls)
      : await callViaOmniRoute(provider.auth, args, inputImageDataUrls)

  const saved = await saveGeneratedImage(args.out, directory, base64)
  return { ...saved, provider: provider.kind }
}
