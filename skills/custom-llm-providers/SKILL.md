---
name: custom-llm-providers
description: "Configure, troubleshoot, and maintain custom LLM providers (OpenAI-compatible endpoints) for Hermes and other AI tools. Covers self-hosted, cloud-hosted, and region-locked endpoints."
version: 1.2.0
author: kimliu
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [llm, providers, custom, endpoints, hermes, openai-compatible]
---

# Custom LLM Providers

## Overview

For providers not natively supported by Hermes, use `custom_providers` in `config.yaml` to define OpenAI-compatible endpoints. This covers self-hosted models (Ollama, LM Studio, vLLM), Chinese cloud providers (火山引擎 Ark, 阿里云 DashScope, 智谱), and any server exposing an OpenAI-compatible `/v1/chat/completions` endpoint.

## Hermes config.yaml Structure

```yaml
custom_providers:
  - api_key: ${ENV_VAR_NAME}       # env var reference (NOT literal string)
    base_url: https://endpoint/api/v3
    model: model-id
    api_mode: codex_responses      # OPTIONAL: switch to Responses API (required for Agent Plan)
    models:
      model-id:
        context_length: 1000000
        type: chat                 # OPTIONAL: per-model protocol hint
    name: my-provider-name
```

## Top-Level Config When Active

Some custom providers need protocol overrides at the top level too. Set via CLI (this is unambiguous — Hermes handles the nested key correctly):

```bash
hermes config set provider volc-agent-plan
hermes config set model ark-code-latest
hermes config set model.api_mode codex_responses
```

The resulting `~/.hermes/config.yaml` will have a scalar `model: ark-code-latest` plus a nested `model.api_mode: codex_responses` — Hermes merges these at runtime.

To verify current top-level model settings:
```bash
grep -E '^model:|model\.' ~/.hermes/config.yaml
```

## Common Pitfalls

1. **API key variable substitution:** Use `${ENV_VAR}` not the bare variable name. `api_key: volc_ark_api_key` passes the literal string `"volc_ark_api_key"` as the API key. `api_key: ${VOLC_ARK_API_KEY}` reads the actual environment variable.

2. **Provider name convention:** Reference custom providers as `custom:<name>` — `hermes config set provider custom:volc-deepseek`, not `volc-deepseek` or `custom_providers:volc-deepseek`.

3. **Session reset required:** After switching provider, start a new session (`/reset` or exit+relaunch). The running session keeps the old provider.

4. **Env vars belong in ~/.hermes/.env, not just ~/.zshrc:** Hermes processes launched from non-interactive contexts (launchd, cron, Docker, gateway) do NOT source shell rc files. All built-in provider keys already live in `~/.hermes/.env`. Add custom provider keys there too:

```bash
echo "MY_CUSTOM_KEY=sk-xxx..." >> ~/.hermes/.env
```

Only add to ~/.zshrc if the user also needs the variable in their interactive shell for curl/debug commands.

5. **Plugin vs model access:** Some providers (火山引擎) require separate plugin activation for tools like `web_search`, even if the model is accessible for chat.

## Env Var Missing: Inject + Persist Workflow

When a user provides an API key mid-session that was previously unset (`$VAR` returns empty → 401), follow the step-by-step guide in:

`skill_view(name="custom-llm-providers", file_path="references/env-var-missing-workflow.md")`

This covers: verify → inject into current shell → persist to .zshrc → curl-verify connectivity.

## Endpoint Verification

Always test a new custom provider with a simple curl before configuring Hermes:

```bash
curl https://endpoint/api/v3/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"model-id","messages":[{"role":"user","content":"hello"}]}'
```

If curl returns 200, the provider works. Debug the Hermes config.

## Switching Between Providers

When user has multiple custom providers and wants instant switching:

1. **Config has entries** in `custom_providers` — one per provider
2. **Toggle `provider:` and `model:`** top-level keys to match the target provider
3. **Method A — Python + yaml (recommended, handles structure correctly):**
   ```python
   import yaml
   with open('/Users/kimliu/.hermes/config.yaml') as f:
       cfg = yaml.safe_load(f)
   cfg['provider'] = 'volc-agent-plan'
   cfg['model'] = 'ark-code-latest'
   cfg.setdefault('model', {})['api_mode'] = 'codex_responses'  # if needed
   with open('/Users/kimliu/.hermes/config.yaml', 'w') as f:
       yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
   ```
   Run from terminal or via `python3 -c "..."` one-liner. Preserves YAML comments with `ruamel.yaml` if available.
4. **Method B — sed** (quick but brittle, breaks YAML flow style):
   ```bash
   sed -i '' 's/^provider: .*/provider: deepseek/' ~/.hermes/config.yaml
   sed -i '' 's/^model: .*/model: deepseek-v4-flash/' ~/.hermes/config.yaml
   ```
5. **Always /reset** after switching — the running session keeps the old provider

**User preference:** do not ask for confirmation. Execute the switch + /reset immediately.

## Provider-Specific Notes

### Deepseek (Official)
- **Base URL:** `https://api.deepseek.com`
- **Env var:** `DEEPSEEK_API_KEY`
- **Models:** `deepseek-v4-flash`, `deepseek-v4-pro` (NOT `deepseek-chat` as of mid-2026)
- **Model listing:** `curl https://api.deepseek.com/models -H "Authorization: Bearer $DEEPSEEK_API_KEY"`

### 火山引擎 Ark (Volcano Engine)
- **Base URL:** `https://ark.cn-beijing.volces.com/api/v3`
- **Env vars:** `ARK_API_KEY` (SDK default), also set `VOLC_ARK_API_KEY` for Hermes compatibility
- **SDK:** OpenAI Python client via `base_url`, OR official `volcengine` PyPI package for native tools
- **Models:** Created as "推理接入点" (inference endpoints) in the console; the model name is the endpoint ID
- **⚠️ Model name must be the full endpoint ID with version suffix.** The Ark API returns models as `deepseek-v4-flash-260425` (with date version), NOT `deepseek-v4-flash`. Using the shorthand name gives HTTP 404 `InvalidEndpointOrModel.NotFound`. Always use the exact model ID from the console or the `/models` API response.
- **Web search tool:** Requires separate plugin activation at console, then bound to the inference endpoint
- **API model listing:** `/models` may 404 — Hermes warns but still saves the config

### 火山引擎 Agent Plan (方舟 Agent Plan)
- **What it is:** A higher-tier subscription plan on 火山引擎 that provides coding-optimized models (via Responses API) and includes image/video generation quotas on Medium+ plans. Uses a different API infrastructure than regular Ark inference endpoints.
- **Base URL:** `https://ark.cn-beijing.volces.com/api/plan/v3` (NOT `/api/v3` — uses the Plan-specific gateway)
- **Env vars:** Same as regular Ark — `VOLC_ARK_API_KEY`
- **Model:** `ark-code-latest` (single rolling alias, NOT per-endpoint IDs with date versions)
- **Required extra field:** `api_mode: codex_responses` — tells Hermes to use the Responses API protocol instead of Chat API. Without this field, requests fail or fall back to incompatible chat completions.
- **Config entry example:**
  ```yaml
  - api_key: ${VOLC_ARK_API_KEY}
    base_url: https://ark.cn-beijing.volces.com/api/plan/v3
    model: ark-code-latest
    api_mode: codex_responses
    models:
      ark-code-latest:
        context_length: 1000000
    name: volc-agent-plan
  ```
- **Required top-level config** when actively using this provider:
  ```yaml
  provider: volc-agent-plan
  model: ark-code-latest
  model:
    api_mode: codex_responses   # also needed at top level
  ```
- **Image/video generation:** Medium+ plans include visual model quotas; configured via separate visual model skill setup (not through `custom_providers`).
- **Automated setup:** Volcengine provides `arkcli helper` (ArkCLI Helper) via `@volcengine/ark-cli` npm package that can auto-configure Hermes — install with `npm install -g @volcengine/ark-cli@latest`, then `arkcli auth login` and `arkcli helper`.

### Ollama
- **Base URL:** `http://localhost:11434/v1`
- **API Key:** `not-needed` (leave blank or use placeholder)
- **Model names:** `ollama/model-name` format in Hermes

### DashScope (阿里云)
- **Env var:** `DASHSCOPE_API_KEY`
- **Base URL:** `https://dashscope.aliyuncs.com/compatible-mode/v1`

### 硅基流动 SiliconFlow
- **Base URL:** `https://api.siliconflow.cn/v1`
- **Env var:** `SILICONFLOW_API_KEY`
- **Model naming:** Uses `org/Model-Name` format — e.g. `deepseek-ai/DeepSeek-V4-Flash`, NOT `deepseek-v4-flash`
- **Model listing:** `curl https://api.siliconflow.cn/v1/models -H "Authorization: Bearer $SILICONFLOW_API_KEY"` — works without auth headers for logged-in users
- **Available DeepSeek V4 models (as of mid-2026):**
  - `deepseek-ai/DeepSeek-V4-Flash`
  - `deepseek-ai/DeepSeek-V4-Pro`
- **⚠️ Model names with "Pro/" prefix:** SiliconFlow also has a tiered access — `Pro/deepseek-ai/DeepSeek-V3.2` exists alongside `deepseek-ai/DeepSeek-V3.2`. For DeepSeek V4 Flash/Pro, the standard `deepseek-ai/` prefix works.
- **Also used with:** `aichat` CLI — the user has a SiliconFlow aichat config at `~/.hermes/scripts/aichat-config.yaml` (or wherever their aichat lives) that doubles as a reference for model availability.

## When Custom Provider Isn't Needed

Many providers have native Hermes support — check `hermes model` or `hermes setup` before creating a custom provider. Native providers handle API key management, model listing, and tool integration automatically.
