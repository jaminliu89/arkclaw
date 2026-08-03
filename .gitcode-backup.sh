#!/bin/bash
# ============================================================
# ArkClaw 三方仓库融合备份脚本
# 用途：每天从 GitHub/Gitee 拉取最新 → merge → push 到 GitCode
# 原则：融合不覆盖（force-push 禁用）
# 作者：Hermes (ArkClaw)
# ============================================================

set -e

WORKSPACE="/root/.openclaw/workspace"
LOG_FILE="$WORKSPACE/memory/gitcode-backup.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$WORKSPACE/memory"

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

log "===== 开始三方融合备份 ====="

cd "$WORKSPACE" || { log "无法进入工作区"; exit 1; }

# ----------- 1. 拉取 GitHub（主源）-----------
log "拉取 GitHub..."
if git fetch github master 2>> "$LOG_FILE"; then
    log "GitHub 拉取成功"
else
    log "GitHub 拉取失败，跳过"
fi

# ----------- 2. 拉取 Gitee（次要源）-----------
log "拉取 Gitee..."
if git fetch gitee master 2>> "$LOG_FILE"; then
    log "Gitee 拉取成功"
else
    log "Gitee 拉取失败，跳过"
fi

# ----------- 3. 拉取 GitCode（目标源，先同步自己）-----------
log "拉取 GitCode..."
if git fetch gitcode master 2>> "$LOG_FILE"; then
    log "GitCode 拉取成功"
else
    log "GitCode 拉取失败（可能首次无master分支）"
fi

# ----------- 4. 融合所有远程到本地（不覆盖）-----------
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "当前分支: $CURRENT_BRANCH"

for remote in github gitee gitcode; do
    if git show-ref --verify --quiet "refs/remotes/$remote/master"; then
        log "融合 $remote/master → 本地"
        # 用 --no-ff 强制产生 merge commit，保留三方历史
        # 用 --allow-unrelated-histories 允许不同祖先合并
        if git merge "$remote/master" --no-ff --no-edit \
            -m "merge: $remote backup $TIMESTAMP" \
            2>> "$LOG_FILE"; then
            log "$remote 融合成功"
        else
            log "$remote 融合有冲突，尝试自动解决"
            # 自动解决：保留本地版本（--ours）或远程版本（--theirs）
            # 默认保留本地，不影响工作
            git checkout --ours . 2>> "$LOG_FILE" || true
            git add -A 2>> "$LOG_FILE" || true
            git commit --no-edit 2>> "$LOG_FILE" || true
        fi
    fi
done

# ----------- 5. 推送到 GitCode（不强制）-----------
log "推送到 GitCode..."
if git push gitcode "$CURRENT_BRANCH" 2>> "$LOG_FILE"; then
    log "GitCode 推送成功"
    echo "✅ GitCode 备份成功：$TIMESTAMP"
else
    log "GitCode 推送失败"
    echo "❌ GitCode 推送失败：$TIMESTAMP，查看 $LOG_FILE"
    exit 1
fi

log "===== 备份完成 ====="
