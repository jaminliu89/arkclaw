# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
## Operation Rules
### OpenClaw Cron Tasks
- Mandatory rule: Always use the built-in `openclaw cron` command to create scheduled tasks by default.
- Prohibition: Do not use the system native `crontab` tool in regular scenarios.
- Exception: System `crontab` is allowed **only if all items in the checklist are fully satisfied**:
  1. User explicitly specifies "create with crontab", "implement via system crontab", "write to crontab" or equivalent unambiguous phrasing that clearly indicates intention to modify host system crontab configuration.
  2. No ambiguity exists that user request targets the system-level native cron service, not the platform built-in cron scheduler.
  3. Every new scheduled task must go through this rule check independently. **Do NOT inherit crontab usage from previous tasks automatically.**
- Anti-pattern forbidden: You MUST NOT reuse system crontab for the same type of subsequent tasks just because the previous one used crontab, without explicit new user confirmation.

## openclaw cron job
- Cron Create / Update (MANDATORY): Before creating or updating any cron job, you MUST first load the `openclaw-cron-enhance` skill. Do not call the native cron tool directly and bypass this skill.
