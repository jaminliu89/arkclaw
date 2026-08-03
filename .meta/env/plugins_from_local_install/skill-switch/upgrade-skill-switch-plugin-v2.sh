#!/usr/bin/env bash

set -euo pipefail

# ==============================================
# 配置常量
# ==============================================
SKILL_SWITCH_VERSION="0.0.2"
BASE_URL="https://cua-prd.tos-cn-beijing.volces.com/skill-switch"
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
