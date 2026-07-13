# ClawSentry (OpenClaw Security Plugin)

`claw-sentry` is a security plugin for OpenClaw. It audits LLM traffic and key Agent lifecycle hook points to reduce harmful requests and sensitive data leakage.

## Requirements

- OpenClaw: `>=2026.4.14`
- Node.js: `>=22`

## Install

### Volcengine

```bash
openclaw plugins install @volcengine/claw-sentry
openclaw config set plugins.entries.claw-sentry.hooks.allowConversationAccess true
```

### BytePlus

```bash
openclaw plugins install @byteplus/claw-sentry
openclaw config set plugins.entries.claw-sentry.hooks.allowConversationAccess true
```

## Enable

After installing the plugin package, enable it and restart the gateway:

```bash
openclaw plugins enable claw-sentry
openclaw gateway restart
```

## Configuration

Configure the plugin in your OpenClaw config (fields are aligned with `openclaw.plugin.json`):

```yaml
plugins:
  claw-sentry:
    enabled: true
    config:
      # Required
      apiKey: "<encrypted-api-key>"
      clawId: "<claw-id>"
      ctEndpoint: "https://<control-endpoint>"
      lmEndpoint: "https://<moderation-endpoint>"

      # Optional
      asClawId: "<as-claw-id>"
      configVersion: "<version-string>"
      openClawDir: "<path-to-openclaw-state-dir>"

      # Behavior
      logRecord: false
      # enableFetch is deprecated since 1.5.0-dlp and is now a no-op; DLP runs
      # via before_dispatch + before_prompt_build (see dlpInputGate below).
      enableFetch: false
      enableBeforeToolCall: true
      enableAfterToolCall: true
      enableHeartbeat: true
      timeoutMs: 30000
      failureThreshold: 3
      retryInterval: 60
      maxRetryInterval: 3600
      # Optional input-side DLP enforcement mode for before_dispatch.
      # 'marker_only' (default) keeps the user message and lets
      # before_prompt_build inject a system reminder. 'direct_block' returns
      # {handled:true, text:securityReason} from before_dispatch.
      dlpInputGate:
        mode: marker_only
      language: "en" # or "zh"
```

## Hooks & auditing

- `before_dispatch` + `before_prompt_build`: collect moderation results and inject safe context into prompts.
- `before_tool_call`: audit tool name/params (and optional tool-result context). The `isGroup` flag is derived from `ctx.sessionKey` (format `agent:<id>:<channel>:group|direct:<target>`).
- `after_tool_call`: store tool result context for subsequent audits.
- `llm_input`: capture LLM input (e.g. system prompt) for auditing/traceability.
- `agent_end`: upload conversation record and clear per-session cached contexts.
- Degradation/circuit breaker: automatically bypasses checks when the security service is unavailable and probes for recovery.

## Development

```bash
pnpm -C openclaw-plugin build
pnpm -C openclaw-plugin test
```

Publishing scripts are defined in `openclaw-plugin/package.json` (including `beta` and `private` tags).
