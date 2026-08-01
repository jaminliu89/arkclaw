#!/bin/bash
# 每日自动备份脚本 - 推送到 GitHub & Gitee
cd /root/.openclaw/workspace

# 避免多个备份同时跑
flock -n /tmp/arkclaw-backup.lock -c "
# 添加所有变更（包括新增、修改、删除）
git add -A

# 如果有变更才提交
if git diff --cached --quiet; then
    echo \"[$(date)] 无变更，跳过提交\"
    exit 0
fi

git commit -m \"auto backup $(date '+%Y-%m-%d %H:%M')\"

# 推送到两个远程
git push github main 2>&1
git push gitee main 2>&1

echo \"[$(date)] 备份完成\"
" 2>&1 || echo "[$(date)] 另一个备份进程正在运行，跳过"
