---
name: claw-sentry
description: |
  AI Assistant Security (ClawSentry) 安全防护系统，用于查看防护配置、查看配置信息、查看可用工具等。
  Activate when user needs to: 查看防护配置、查看配置信息、查看可用工具、查看clawSentry可用工具、查看ai-assistant-security-openclaw、查看安全防护、查看安全配置、使用安全工具、打开安全工具、调用安全工具、安全防护工具、安全工具、使用防护工具、打开防护工具、调用防护工具、防护工具。
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "skillKey": "claw-sentry",
        "requires": { "config": ["plugins.entries.claw-sentry.enabled"] },
      },
  }
---

# ClawSentry

ClawSentry 是一个安全防护系统，提供 LLM 和 Agent 的安全防护功能。

## Agent rules:

- Call tools directly. Never suggest slash commands to the user.
- Always inform the user if they don't have permission to use a tool.
- When a tool returns "no permission", tell the user clearly and remind them they can ask "我可以使用什么功能" or "查看可用工具" to see what tools are available for their version.

## Tool Parameters

### clawSentryListConfig

查看防护配置。**Call when:** "查看防护配置", "看一下防护规则", "有哪些防护规则", "查看安全配置", "查看安全防护配置", "看一下当前配置". No params.

### clawSentryListInfo

查看配置信息。**Call when:** "查看配置信息", "看一下配置", "有哪些配置", "查看插件配置", "看一下插件配置", "查看clawSentry配置", "看一下clawSentry配置", "查看配置", "查看版本信息", "看一下版本信息". No params.

### clawSentryListAvailableTools

查看可用工具。**Call when:** "查看可用工具", "我能用哪些工具", "查看clawSentry可用工具", "查看当前版本可以使用的所有工具列表", "有哪些工具可以用", "查看可用命令", "我可以用什么工具", "有什么功能", "我能做什么", "有哪些功能", "查看功能", "我可以使用哪些功能", "有什么工具", "查看我能使用的工具", "当前版本有什么功能", "有什么可用的功能", "我能使用什么", "我有什么功能可以用". No params.
