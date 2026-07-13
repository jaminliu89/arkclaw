#!/usr/bin/env bash

set -euo pipefail

# ==============================================
# 配置常量
# ==============================================
SKILL_SWITCH_VERSION="0.0.2"
BASE_URL="https://arkclaw-xua.tos-cn-beijing.volces.com/plugins/skill-switch"
TMP_DIR="/tmp/skill-switch"
WORKSPACE_SKILLS_DIR="/root/.openclaw/workspace/skills/"

# ==============================================
# 开始安装
# ==============================================
echo "Creating temporary directory..."
mkdir -p "$TMP_DIR"
cd "$TMP_DIR"

# 1. 安装 skill-switch 插件
echo "Downloading skill-switch.tar.gz..."
wget -O 'skill-switch.tar.gz' "${BASE_URL}/${SKILL_SWITCH_VERSION}/skill-switch.tar.gz"

echo "Extracting and installing skill-switch plugin..."
tar -xf skill-switch.tar.gz
cd skill-switch

# 判断 openclaw 版本：
#   >= 2026.3.28 → 使用 'plugin-manager.sh install .'
#   <  2026.3.28 → 打印 'unsupport version' 并退出
OPENCLAW_VERSION_MIN="2026.3.28"
OPENCLAW_VERSION_RAW="$(openclaw --version 2>/dev/null || true)"
# 输出格式形如：'OpenClaw 2026.5.4 (325df3e)'，提取版本号 2026.5.4
OPENCLAW_VERSION="$(echo "$OPENCLAW_VERSION_RAW" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"

if [ -z "$OPENCLAW_VERSION" ]; then
  echo "unsupport version"
  exit 1
fi

# sort -V 升序排序后，最大的版本号在最后一行
highest="$(printf '%s\n%s\n' "$OPENCLAW_VERSION_MIN" "$OPENCLAW_VERSION" | sort -V | tail -n1)"

if [ "$highest" = "$OPENCLAW_VERSION" ]; then
  install_label=">= $OPENCLAW_VERSION_MIN"
else
  echo "unsupport version"
  exit 1
fi

# 若已存在旧的 skill-switch 插件，先卸载并等待 gateway 重新进入 running 状态
EXTENSION_DIR="${HOME}/.openclaw/extensions/skill-switch"
if [ -d "$EXTENSION_DIR" ]; then
  echo "Detected existing skill-switch at $EXTENSION_DIR, uninstalling..."
  bash ./plugin-manager.sh uninstall skill-switch
fi

echo "Detected openclaw $OPENCLAW_VERSION ($install_label), installing skill-switch via plugin-manager.sh..."
bash ./plugin-manager.sh install .
cd "$TMP_DIR"

# 2. 安装 opencli skill
echo "Downloading opencli.tar.gz..."
wget -O 'opencli.tar.gz' "${BASE_URL}/${SKILL_SWITCH_VERSION}/opencli.tar.gz"

echo "Extracting and copying opencli skill to workspace..."
tar -xf opencli.tar.gz
mkdir -p "$WORKSPACE_SKILLS_DIR"
cp -rf opencli "$WORKSPACE_SKILLS_DIR"

echo "Running opencli install script..."
chmod +x "$WORKSPACE_SKILLS_DIR/opencli/install.sh"
sudo bash "$WORKSPACE_SKILLS_DIR/opencli/install.sh"

# 3. 安装 XUA-auto skill
echo "Downloading XUA-auto.tar.gz..."
wget -O 'XUA-auto.tar.gz' "${BASE_URL}/${SKILL_SWITCH_VERSION}/XUA-auto.tar.gz"

echo "Extracting and copying XUA-auto skill to workspace..."
tar -xf XUA-auto.tar.gz
cp -rf XUA-auto "$WORKSPACE_SKILLS_DIR"

# ==============================================
# 清理与完成
# ==============================================
echo "Cleaning up temporary files..."
rm -rf "$TMP_DIR"

echo "SKILL_PLUGIN_INSTALL_SUCCESS"
