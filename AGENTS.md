# AGENTS.md

## Project Shape

- Bun is the package manager/runtime; use `bun install --frozen-lockfile` with the committed `bun.lock`.
- The package ships two hosts for the same `gpt_imagegen` tool: `src/index.ts` (OpenCode plugin wiring) and `src/mcp.ts` (stdio MCP server used by the Claude Code plugin and the `gpt-imagegen-mcp` bin). Both build their schema from the shared description strings and call `generateImage` in `src/generate.ts`. Helpers live in role-based modules — `src/types.ts` (shared types), `src/auth.ts` (auth/provider resolution), `src/input-image.ts` (reference image reading), `src/output-image.ts` (non-overwriting save + message), `src/codex.ts` (Codex backend call + SSE parsing), `src/omniroute.ts` (OmniRoute image generation fallback).
- `bun run build` bundles `src/index.ts` into `dist/index.js` via `bun build --target node --format esm --packages external` (dependencies, including the `@opencode-ai/plugin` peer dep, stay external), and `src/mcp.ts` into a fully self-contained `dist/mcp.js` (no `--packages external`): Claude Code installs npm-sourced plugins without their dependencies. That is also why `@modelcontextprotocol/server` and `zod` are devDependencies. Bundling avoids the extensionless relative imports `tsc` would emit, which native Node ESM cannot resolve. No `.d.ts` is published — the plugin is loaded by OpenCode at runtime, not imported as a typed library.
- `dist/` is ignored locally but is the publish artifact (`index.js` and `mcp.js`). Run `bun run build` before inspecting package output.
- `.claude-plugin/plugin.json` is the Claude Code plugin manifest (published; declares the `imagegen` MCP server as `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`). `.claude-plugin/marketplace.json` is repo-only and points the `gpt-imagegen` plugin at the npm package, so installs always use the published build. Check both with `claude plugin validate .`.
- `bunfig.toml` enforces `install.minimumReleaseAge = 172800` (2 days): newly published versions are filtered out by `bun install` / `bun add` / `bun outdated`.

## Commands

- Tests are split by kind: `tests/unit/` (helper-module unit tests) and `tests/e2e/` (one file per auth path, e.g. `subscription.test.ts`).
- `bun run typecheck` runs `tsc --noEmit` over `src` and `tests`.
- `bunx biome ci .` is the CI formatter/linter check.
- `bun run check` runs `biome check --write .`; it may modify files.
- `bun run test` runs `bun test tests/unit` — unit tests only, and is what CI uses. (A bare `bun test` would also discover the e2e files under `tests/e2e/` and try to run them for real, so prefer the script.)
- `bun run test:e2e_subscription` sets `OPENCODE_MODEL=openai/gpt-6.1-sol` and runs `tests/e2e/subscription.test.ts`, which forces the ChatGPT subscription provider/model path. It can take minutes because it calls `opencode run` and generates real images. `bun run test:e2e_omniroute` forces the OmniRoute provider and `codex/gpt-6.1-sol` inside the test child process.
- Each e2e path is its own script (its own `bun test` process), which also avoids the unit-test `process.env` leak into the single-process e2e `opencode` spawn.
- CI runs `bun run typecheck`, `bunx biome ci .`, and `bun run test`. The e2e suites are not run in CI's default checks (they need real auth + generations); they are invoked separately via their `test:e2e_*` scripts.

## E2E Requirements

- The files under `tests/e2e/` shell out to the `opencode` CLI with `--dangerously-skip-permissions` in temporary workdirs.
- Subscription E2E requires OpenCode to be authenticated with ChatGPT OAuth; the plugin reads `OPENCODE_AUTH_CONTENT` first, then `$XDG_DATA_HOME/opencode/auth.json`. OmniRoute E2E uses an isolated temporary config, so its API credential must be available through OpenCode auth and non-local deployments should set `GPT_IMAGEGEN_OMNIROUTE_BASE_URL` explicitly. Its orchestrator model can be selected with `OPENCODE_MODEL`.
- The e2e tests assert that produced files are valid PNGs and cover the plugin's output auto-versioning behavior. Exact dimensions are not asserted because Codex-backed providers may return auto-selected output.

## Implementation Notes

- The exposed tool is `gpt_imagegen`; provider resolution defaults to Codex OAuth first and falls back to OmniRoute API auth when Codex OAuth is unavailable. Set `GPT_IMAGEGEN_AUTH_PROVIDER=codex|omniroute` to force one path.
- Codex mode calls the ChatGPT Codex responses endpoint with the hosted `image_generation` tool and defaults to `gpt-6.1-sol`; `GPT_IMAGEGEN_CODEX_MODEL` overrides it. OmniRoute mode calls OpenAI-compatible `POST /v1/images/generations`, defaults to image model `codex/gpt-6.1-sol`, omits unverified `quality`, and forwards reference images as `image_url` / `image_urls` data URLs.
- Codex OAuth may ignore requested `size` and `quality`; OmniRoute may ignore `size` and does not receive `quality`. The plugin preserves returned PNGs without rescaling them.
- ChatGPT OAuth is read from OpenCode auth first, then from the Codex CLI login (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`). Access tokens whose JWT `exp` has passed are skipped, as are JWTs that carry a `https://api.openai.com/auth` claim without `chatgpt_account_id` (OpenCode V2 `chatgpt-token-sharing` credentials, which the Codex backend rejects with 401 `rejected_by_access_enforcement`). Opaque credentials and tokens without that claim are left to the backend. The plugin never refreshes or writes either file, because the refresh tokens rotate and belong to those tools.
- OmniRoute key/base URL come from `GPT_IMAGEGEN_OMNIROUTE_API_KEY` / `GPT_IMAGEGEN_OMNIROUTE_BASE_URL` first, then OpenCode auth/config. The Claude Code plugin maps its `userConfig` options onto those env vars, and Claude Code substitutes unconfigured options as empty strings, so empty env values must be treated as unset.
- Output paths are resolved relative to the OpenCode context directory (MCP server: `CLAUDE_PROJECT_DIR`, else the working directory) unless absolute, and existing files are never overwritten; suffixes `-v2` through `-v999` are tried.
- Reference images are read from paths relative to the same base directory and are embedded as data URLs after MIME detection.

## Publishing

- `package.json` `files` intentionally publishes only `dist`, `.claude-plugin/plugin.json`, `README.md`, and `LICENSE`.
- Claude Code detects plugin updates by the `plugin.json` version, so the npm `version` lifecycle script (`scripts/sync-plugin-version.ts`) copies the bumped version into it and stages it into the release commit; `tests/unit/plugin-manifest.test.ts` fails if the two drift.
- `prepublishOnly` runs `bun run build`, so `npm publish` always rebuilds `dist/` first.
- Release flow: run `bun run release:patch` (or `:minor` / `:major`) on a clean `main`. The script checks the working tree is clean and in sync with the branch's configured upstream, prints the commits since the previous tag along with a GitHub compare URL for diff review, asks for confirmation, and runs `npm version <level>` to create and verify the `chore: release X.Y.Z` commit and `vX.Y.Z` tag locally. It then atomically pushes that commit and tag to the verified upstream remote, so a rejected branch update cannot publish an orphaned tag.
- The tag push triggers `.github/workflows/release.yml`, which runs `npm publish --provenance --access public` via npm OIDC trusted publisher (no `NPM_TOKEN` secret) and creates a GitHub release with auto-generated notes. If a fork does not emit tag-push runs, manually dispatch the same workflow on the existing release tag (for example, `gh workflow run release.yml --ref v0.1.11`); it only runs from a tag ref and checks that the tag version matches `package.json` and that the tagged commit is on `main`. The npm package must have GitHub Actions registered as a trusted publisher on npmjs.com for OIDC to work.
