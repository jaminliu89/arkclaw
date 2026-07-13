#!/usr/bin/env bash
#
# plugin-manager.sh - OpenClaw Plugin Installation/Uninstallation Script
#
# Usage:
#   ./plugin-manager.sh install <plugin-path> [--link]
#   ./plugin-manager.sh upgrade <plugin-path> [--link]
#   ./plugin-manager.sh uninstall <plugin-id>
#   ./plugin-manager.sh list
#   ./plugin-manager.sh build
#   ./plugin-manager.sh help
#
# Description:
#   Manages OpenClaw plugins by installing/uninstalling them to/from
#   the extensions directory (~/.openclaw/extensions/).
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

OPENCLAW_DIR="${HOME}/.openclaw"
EXTENSIONS_DIR="${OPENCLAW_DIR}/extensions"
CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"

msg_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
msg_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
msg_warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
msg_error() { echo -e "${RED}[ERROR]${NC} $1"; }

ensure_dirs() {
    mkdir -p "$OPENCLAW_DIR"
    mkdir -p "$EXTENSIONS_DIR"
}

get_plugin_id() {
    local plugin_dir="$1"
    local manifest="${plugin_dir}/openclaw.plugin.json"
    
    if [[ -f "$manifest" ]]; then
        local id
        id=$(grep -m1 '"id"' "$manifest" 2>/dev/null | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
        if [[ -n "$id" ]]; then
            echo "$id"
            return 0
        fi
    fi
    
    local pkg="${plugin_dir}/package.json"
    if [[ -f "$pkg" ]]; then
        local name
        name=$(grep -m1 '"name"' "$pkg" 2>/dev/null | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
        if [[ -n "$name" ]]; then
            echo "$name"
            return 0
        fi
    fi
    
    basename "$plugin_dir"
}

validate_plugin_dir() {
    local plugin_dir="$1"
    
    if [[ ! -d "$plugin_dir" ]]; then
        msg_error "Plugin directory does not exist: $plugin_dir"
        return 1
    fi
    
    if [[ ! -f "${plugin_dir}/package.json" ]]; then
        msg_error "Plugin directory must contain package.json: ${plugin_dir}"
        return 1
    fi
    
    if [[ ! -f "${plugin_dir}/openclaw.plugin.json" ]]; then
        msg_error "Plugin directory must contain openclaw.plugin.json: ${plugin_dir}"
        return 1
    fi
    
    local pkg="${plugin_dir}/package.json"
    if ! grep -q '"openclaw"' "$pkg" 2>/dev/null; then
        msg_error "package.json must contain 'openclaw' field with 'extensions' array"
        return 1
    fi
    
    return 0
}

init_config() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        echo '{}' > "$CONFIG_FILE"
    fi
}

has_allowlist() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        return 1
    fi
    if command -v jq &>/dev/null; then
        local allow_count
        allow_count=$(jq '.plugins.allow // [] | length' "$CONFIG_FILE" 2>/dev/null || echo "0")
        [[ "$allow_count" -gt 0 ]]
        return $?
    fi
    grep -q '"allow"' "$CONFIG_FILE" 2>/dev/null && grep -q '\[' "$CONFIG_FILE" 2>/dev/null
}

update_config_install() {
    local plugin_id="$1"
    local install_path="$2"
    local source_path="$3"
    local version="${4:-}"
    local mode="${5:-copy}"
    
    init_config
    
    local tmp_config="${CONFIG_FILE}.tmp.$$"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    
    if command -v jq &>/dev/null; then
        local source_type="path"
        [[ "$mode" == "link" ]] && source_type="path"
        
        local has_allow
        has_allow=$(jq 'has("plugins") and (.plugins.allow // [] | length > 0)' "$CONFIG_FILE" 2>/dev/null || echo "false")
        
        if [[ "$has_allow" == "true" ]]; then
            jq --arg id "$plugin_id" \
               --arg path "$install_path" \
               --arg src "$source_path" \
               --arg ver "$version" \
               --arg ts "$timestamp" \
               --arg src_type "$source_type" \
               '
               .plugins = (.plugins // {}) |
               .plugins.installs = (.plugins.installs // {}) |
               .plugins.installs[$id] = {
                   "source": $src_type,
                   "sourcePath": $src,
                   "installPath": $path,
                   "version": (if $ver != "" then $ver else null end),
                   "installedAt": $ts
               } |
               .plugins.entries = (.plugins.entries // {}) |
               .plugins.entries[$id] = (.plugins.entries[$id] // {"enabled": true}) |
               .plugins.allow = (.plugins.allow // []) |
               .plugins.allow = (.plugins.allow | if index($id) then . else . + [$id] end)
               ' "$CONFIG_FILE" > "$tmp_config" && mv "$tmp_config" "$CONFIG_FILE"
            msg_info "Added '$plugin_id' to plugins.allow list"
        else
            jq --arg id "$plugin_id" \
               --arg path "$install_path" \
               --arg src "$source_path" \
               --arg ver "$version" \
               --arg ts "$timestamp" \
               --arg src_type "$source_type" \
               '
               .plugins = (.plugins // {}) |
               .plugins.installs = (.plugins.installs // {}) |
               .plugins.installs[$id] = {
                   "source": $src_type,
                   "sourcePath": $src,
                   "installPath": $path,
                   "version": (if $ver != "" then $ver else null end),
                   "installedAt": $ts
               } |
               .plugins.entries = (.plugins.entries // {}) |
               .plugins.entries[$id] = (.plugins.entries[$id] // {"enabled": true})
               ' "$CONFIG_FILE" > "$tmp_config" && mv "$tmp_config" "$CONFIG_FILE"
        fi
    else
        msg_warn "jq not found, config file not updated automatically"
        msg_info "Please add the following to $CONFIG_FILE:"
        echo ""
        echo '  "plugins": {'
        echo '    "installs": {'
        echo "      \"${plugin_id}\": {"
        echo "        \"source\": \"path\","
        echo "        \"sourcePath\": \"${source_path}\","
        echo "        \"installPath\": \"${install_path}\""
        echo "      }"
        echo '    }'
        echo '  }'
    fi
}

update_config_uninstall() {
    local plugin_id="$1"
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        return 0
    fi
    
    if command -v jq &>/dev/null; then
        local tmp_config="${CONFIG_FILE}.tmp.$$"
        local has_allow
        has_allow=$(jq 'has("plugins") and (.plugins.allow // [] | length > 0)' "$CONFIG_FILE" 2>/dev/null || echo "false")
        
        if [[ "$has_allow" == "true" ]]; then
            jq --arg id "$plugin_id" '
                .plugins.installs = (.plugins.installs // {}) | del(.plugins.installs[$id]) |
                .plugins.entries = (.plugins.entries // {}) | del(.plugins.entries[$id]) |
                .plugins.allow = ((.plugins.allow // []) - [$id])
            ' "$CONFIG_FILE" > "$tmp_config" && mv "$tmp_config" "$CONFIG_FILE"
            msg_info "Removed '$plugin_id' from plugins.allow list"
        else
            jq --arg id "$plugin_id" '
                .plugins.installs = (.plugins.installs // {}) | del(.plugins.installs[$id]) |
                .plugins.entries = (.plugins.entries // {}) | del(.plugins.entries[$id])
            ' "$CONFIG_FILE" > "$tmp_config" && mv "$tmp_config" "$CONFIG_FILE"
        fi
    else
        msg_warn "jq not found, config file not updated automatically"
    fi
}

install_plugin() {
    local plugin_path="$1"
    local link_mode="${2:-false}"
    
    if [[ "${plugin_path:0:1}" != "/" ]]; then
        plugin_path="$(cd "$(dirname "$plugin_path")" 2>/dev/null && pwd)/$(basename "$plugin_path")"
    fi
    
    if ! validate_plugin_dir "$plugin_path"; then
        return 1
    fi
    
    local plugin_id
    plugin_id=$(get_plugin_id "$plugin_path")
    
    if [[ -z "$plugin_id" ]]; then
        msg_error "Could not determine plugin ID"
        return 1
    fi
    
    ensure_dirs
    
    local target_dir="${EXTENSIONS_DIR}/${plugin_id}"
    
    if [[ -d "$target_dir" ]] || [[ -L "$target_dir" ]]; then
        msg_warn "Plugin '$plugin_id' already installed. Removing..."
        rm -rf "$target_dir"
    fi
    
    local version=""
    if [[ -f "${plugin_path}/package.json" ]]; then
        version=$(grep -m1 '"version"' "${plugin_path}/package.json" 2>/dev/null | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
    fi
    
    if [[ "$link_mode" == "true" ]]; then
        msg_info "Linking plugin '$plugin_id' from: $plugin_path"
        ln -s "$plugin_path" "$target_dir"
        update_config_install "$plugin_id" "$plugin_path" "$plugin_path" "$version" "link"
        msg_success "Plugin '$plugin_id' linked successfully"
    else
        msg_info "Installing plugin '$plugin_id' from: $plugin_path"
        cp -r "$plugin_path" "$target_dir"
        update_config_install "$plugin_id" "$target_dir" "$plugin_path" "$version" "copy"
        msg_success "Plugin '$plugin_id' installed successfully to: $target_dir"
    fi
    
    echo ""
    # skill-switch 专属 openclaw.json 配置(集中真理源,所有 install 链路自动获得)
    if [[ "$plugin_id" == "skill-switch" ]]; then
        apply_skill_switch_config
    fi

    echo "  ID:      $plugin_id"
    echo "  Version: ${version:-unknown}"
    echo "  Path:    $target_dir"
    echo ""
    echo "Restart OpenClaw gateway to activate the plugin."
}

# ===== skill-switch 专属 openclaw.json 配置(集中真理源)=====
# install.sh / upgrade.py / activate-xua.sh 等所有链路都经 plugin-manager.sh
# install,故 skill-switch 的 openclaw.json 配置收敛于此,install 成功后统一
# 应用;uninstall 删 entry 后再 install 会自动补回。
OPENCLAW_TIMEOUTS_MIN="2026.5.3"
OPENCLAW_ALLOWCONV_MIN="2026.4.24"

# 输出形如 'OpenClaw 2026.5.4 (325df3e)' 中的 2026.5.4;解析失败输出空字符串。
# ⚠️ set -euo pipefail 下 grep 无匹配会让命令替换非 0 退出 → 末尾 || true 兜底。
detect_openclaw_version() {
    local raw
    raw="$(openclaw --version 2>/dev/null || true)"
    printf '%s' "$raw" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true
}

# version_at_least <v> <min> -> 0 if v >= min (sort -V;版本已是 X.Y.Z 无 prerelease)
version_at_least() {
    local v="$1" min="$2" highest
    [ -n "$v" ] || return 1
    highest="$(printf '%s\n%s\n' "$min" "$v" | sort -V | tail -n1)"
    [ "$highest" = "$v" ]
}

# 对 skill-switch 应用 openclaw.json patch。必须在 update_config_install 写完
# installs/entries 之后调用。全部幂等。
apply_skill_switch_config() {
    local cfg="$CONFIG_FILE" tmp ocv
    if [[ ! -f "$cfg" ]] || ! command -v jq >/dev/null 2>&1 || ! jq empty "$cfg" >/dev/null 2>&1; then
        msg_warn "skill-switch config patch skipped (jq missing / $cfg absent or invalid JSON)"
        return 0
    fi
    # openclaw 版本:供 ②③ 版本 gate 共用。解析失败为空串 → version_at_least 返回 1 →
    # 走删 stale 分支,绝不写新 key(对低版本/未知版本 fail-safe)。
    ocv="$(detect_openclaw_version)"

    # ① installs.sourcePath <- installPath:installs 是老 key,无版本 gate。
    if jq -e '.plugins.installs["skill-switch"]' "$cfg" >/dev/null 2>&1; then
        tmp="${cfg}.tmp.$$"
        if jq '.plugins.installs["skill-switch"].sourcePath = .plugins.installs["skill-switch"].installPath' "$cfg" >"$tmp"; then
            mv "$tmp" "$cfg"
            msg_info "Patched plugins.installs.skill-switch.sourcePath -> installPath"
        else
            rm -f "$tmp"; msg_warn "Failed to patch sourcePath; preserving original."
        fi
    fi

    # ② entries.config.injection.lowPrioritySkills:推荐默认配置。与 manifest
    # configSchema 对齐,安装/升级时幂等写入 host 侧 plugin config;已存在时保留用户配置。
    tmp="${cfg}.tmp.$$"
    if jq '.plugins.entries["skill-switch"].config.injection.lowPrioritySkills //= ["XUA-auto"]' "$cfg" >"$tmp"; then
        mv "$tmp" "$cfg"
        msg_info "Ensured plugins.entries.skill-switch.config.injection.lowPrioritySkills default"
    else
        rm -f "$tmp"; msg_warn "Failed to patch injection.lowPrioritySkills; preserving original."
    fi

    # ③ entries.hooks.allowConversationAccess:openclaw >= 2026.4.24 才支持
    #    (2026.4.24-beta.1 引入,openclaw #71221)。低版本写它会被 strict schema 判
    #    Unrecognized key → 整份 openclaw.json 失效 → Gateway aborted,故低版本删 stale 自愈。
    tmp="${cfg}.tmp.$$"
    if version_at_least "$ocv" "$OPENCLAW_ALLOWCONV_MIN"; then
        if jq '.plugins.entries["skill-switch"].hooks.allowConversationAccess = true' "$cfg" >"$tmp"; then
            mv "$tmp" "$cfg"
            msg_info "Patched plugins.entries.skill-switch.hooks.allowConversationAccess = true"
        else
            rm -f "$tmp"; msg_warn "Failed to patch allowConversationAccess; preserving original."
        fi
    else
        if jq -e '.plugins.entries["skill-switch"].hooks.allowConversationAccess != null' "$cfg" >/dev/null 2>&1 \
            && jq 'del(.plugins.entries["skill-switch"].hooks.allowConversationAccess)' "$cfg" >"$tmp"; then
            mv "$tmp" "$cfg"
            msg_info "Removed stale allowConversationAccess (openclaw ${ocv:-unknown} < ${OPENCLAW_ALLOWCONV_MIN})"
        else
            rm -f "$tmp"
        fi
    fi

    # ④ entries.hooks.timeouts.llm_output = 500:openclaw >= 2026.5.3 才支持;低版本写它
    # 会被 strict schema 判 Unrecognized key → 整份 config 失效,故低版本删 stale 自愈。
    tmp="${cfg}.tmp.$$"
    if version_at_least "$ocv" "$OPENCLAW_TIMEOUTS_MIN"; then
        if jq '.plugins.entries["skill-switch"].hooks.timeouts.llm_output = 500' "$cfg" >"$tmp"; then
            mv "$tmp" "$cfg"
            msg_info "Patched plugins.entries.skill-switch.hooks.timeouts.llm_output = 500"
        else
            rm -f "$tmp"; msg_warn "Failed to patch hooks.timeouts.llm_output; preserving original."
        fi
    else
        if jq -e '.plugins.entries["skill-switch"].hooks.timeouts != null' "$cfg" >/dev/null 2>&1 \
            && jq 'del(.plugins.entries["skill-switch"].hooks.timeouts)' "$cfg" >"$tmp"; then
            mv "$tmp" "$cfg"
            msg_info "Removed stale hooks.timeouts (openclaw ${ocv:-unknown} < ${OPENCLAW_TIMEOUTS_MIN})"
        else
            rm -f "$tmp"
        fi
    fi
}

uninstall_plugin() {
    local plugin_id="$1"
    
    if [[ -z "$plugin_id" ]]; then
        msg_error "Plugin ID is required"
        return 1
    fi
    
    local target_dir="${EXTENSIONS_DIR}/${plugin_id}"
    
    if [[ ! -d "$target_dir" ]] && [[ ! -L "$target_dir" ]]; then
        msg_error "Plugin '$plugin_id' is not installed"
        msg_info "Installed plugins:"
        list_plugins
        return 1
    fi
    
    msg_info "Uninstalling plugin '$plugin_id'..."
    rm -rf "$target_dir"
    update_config_uninstall "$plugin_id"
    
    msg_success "Plugin '$plugin_id' uninstalled successfully"
    echo ""
    echo "Restart OpenClaw gateway to apply changes."
}

upgrade_plugin() {
    local plugin_path="$1"
    local link_mode="${2:-false}"

    if [[ "${plugin_path:0:1}" != "/" ]]; then
        plugin_path="$(cd "$(dirname "$plugin_path")" 2>/dev/null && pwd)/$(basename "$plugin_path")"
    fi

    if ! validate_plugin_dir "$plugin_path"; then
        return 1
    fi

    local plugin_id
    plugin_id=$(get_plugin_id "$plugin_path")

    if [[ -z "$plugin_id" ]]; then
        msg_error "Could not determine plugin ID"
        return 1
    fi

    ensure_dirs

    local target_dir="${EXTENSIONS_DIR}/${plugin_id}"
    local state_file="${target_dir}/state.json"
    local backup_dir=""
    local backup_state=""
    local has_state="false"

    if [[ -f "$state_file" ]]; then
        backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-plugin-upgrade-${plugin_id}.XXXXXX")"
        backup_state="${backup_dir}/state.json"
        if ! cp -p "$state_file" "$backup_state"; then
            msg_error "Failed to save existing '$plugin_id' state: $state_file"
            rm -rf "$backup_dir"
            return 1
        fi
        has_state="true"
        msg_info "Saved existing '$plugin_id' state: $state_file"
    fi

    if [[ -d "$target_dir" ]] || [[ -L "$target_dir" ]]; then
        msg_info "Upgrading plugin '$plugin_id'..."
        if uninstall_plugin "$plugin_id"; then
            :
        else
            local status=$?
            msg_error "Plugin '$plugin_id' upgrade failed during uninstall"
            if [[ "$has_state" == "true" ]]; then
                mkdir -p "$(dirname "$state_file")"
                cp -p "$backup_state" "$state_file" || true
                msg_warn "Restored saved state.json after failed uninstall: $state_file"
                msg_warn "Temporary backup retained at: $backup_state"
            fi
            return "$status"
        fi
    else
        msg_warn "Plugin '$plugin_id' is not installed. Installing fresh."
    fi

    if install_plugin "$plugin_path" "$link_mode"; then
        if [[ "$has_state" == "true" ]]; then
            mkdir -p "$(dirname "$state_file")"
            if ! cp -p "$backup_state" "$state_file"; then
                msg_error "Failed to restore existing '$plugin_id' state: $state_file"
                msg_warn "Temporary backup retained at: $backup_state"
                return 1
            fi
            msg_info "Restored existing '$plugin_id' state: $state_file"
            rm -rf "$backup_dir"
        fi
        msg_success "Plugin '$plugin_id' upgraded successfully"
    else
        local status=$?
        msg_error "Plugin '$plugin_id' upgrade failed during install"
        if [[ "$has_state" == "true" ]]; then
            mkdir -p "$(dirname "$state_file")"
            cp -p "$backup_state" "$state_file" || true
            msg_warn "Restored saved state.json after failed upgrade: $state_file"
            msg_warn "Temporary backup retained at: $backup_state"
        fi
        return "$status"
    fi
}

list_plugins() {
    if [[ ! -d "$EXTENSIONS_DIR" ]]; then
        echo "No plugins installed."
        echo ""
        echo "Extensions directory: $EXTENSIONS_DIR"
        return 0
    fi
    
    local allowlist=""
    if command -v jq &>/dev/null && [[ -f "$CONFIG_FILE" ]]; then
        allowlist=$(jq -r '.plugins.allow // [] | join(" ")' "$CONFIG_FILE" 2>/dev/null || echo "")
    fi
    
    local count=0
    echo "Installed plugins:"
    echo ""
    
    for entry in "$EXTENSIONS_DIR"/*; do
        [[ -e "$entry" ]] || continue
        
        local plugin_id
        plugin_id=$(basename "$entry")
        
        local manifest="${entry}/openclaw.plugin.json"
        local pkg="${entry}/package.json"
        
        local name="$plugin_id"
        local description=""
        local version=""
        local linked=""
        local allowed=""
        
        if [[ -L "$entry" ]]; then
            linked=" (linked)"
        fi
        
        if [[ -n "$allowlist" ]] && echo " $allowlist " | grep -q " $plugin_id "; then
            allowed=" [allowed]"
        fi
        
        if [[ -f "$manifest" ]]; then
            local manifest_name
            manifest_name=$(grep -m1 '"name"' "$manifest" 2>/dev/null | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
            [[ -n "$manifest_name" ]] && name="$manifest_name"
            
            description=$(grep -m1 '"description"' "$manifest" 2>/dev/null | sed 's/.*"description"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
        fi
        
        if [[ -f "$pkg" ]]; then
            local pkg_name
            pkg_name=$(grep -m1 '"name"' "$pkg" 2>/dev/null | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
            [[ -n "$pkg_name" && "$pkg_name" != "@openclaw/"* ]] && name="$pkg_name"
            
            version=$(grep -m1 '"version"' "$pkg" 2>/dev/null | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
        fi
        
        echo "  • ${plugin_id}${linked}${allowed}"
        echo "    Name: ${name}"
        [[ -n "$version" ]] && echo "    Version: ${version}"
        [[ -n "$description" ]] && echo "    Desc: ${description}"
        echo "    Path: ${entry}"
        echo ""
        ((count++)) || true
    done
    
    if [[ $count -eq 0 ]]; then
        echo "  No plugins found"
    fi
    
    echo "Total: $count plugin(s)"
    
    if [[ -n "$allowlist" ]]; then
        echo ""
        echo "Allowlist: $allowlist"
    fi
    
    echo ""
    echo "Config: $CONFIG_FILE"
}

build_plugin() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    msg_info "Building plugin in: $script_dir"
    
    if [[ -f "${script_dir}/package.json" ]]; then
        if grep -q '"build"' "${script_dir}/package.json"; then
            cd "$script_dir"
            npm run build
            msg_success "Build completed"
        else
            msg_warn "No 'build' script found in package.json"
        fi
    else
        msg_error "No package.json found in $script_dir"
        return 1
    fi
}

package_plugin() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local plugin_id
    plugin_id=$(get_plugin_id "$script_dir")
    
    local output="${plugin_id}.tar.gz"
    
    msg_info "Packaging plugin to: $output"
    
    tar -czvf "$output" \
        --exclude='node_modules' \
        --exclude='*.test.ts' \
        --exclude='vitest.config.ts' \
        --exclude='.git' \
        -C "$(dirname "$script_dir")" \
        "$(basename "$script_dir")"
    
    msg_success "Package created: $output"
}

show_help() {
    cat << 'EOF'
plugin-manager.sh - OpenClaw Plugin Installation/Uninstallation Script

USAGE:
    ./plugin-manager.sh <command> [arguments]

COMMANDS:
    install <plugin-path> [--link]
        Install a plugin from a directory.
        
        Options:
            --link    Create a symbolic link instead of copying
        
        Examples:
            ./plugin-manager.sh install /path/to/my-plugin
            ./plugin-manager.sh install ./plugins/my-plugin --link

    upgrade <plugin-path> [--link]
        Upgrade a plugin from a directory. If the existing plugin directory
        contains state.json, it is restored after reinstalling.

        Options:
            --link    Create a symbolic link instead of copying

        Examples:
            ./plugin-manager.sh upgrade /path/to/my-plugin
            ./plugin-manager.sh upgrade ./plugins/my-plugin --link

    uninstall <plugin-id>
        Remove an installed plugin.
        
        Examples:
            ./plugin-manager.sh uninstall my-plugin

    list
        List all installed plugins.

    build
        Build the current plugin (runs npm run build).

    package
        Create a tar.gz archive of the current plugin.

    help
        Show this help message.

PLUGIN STRUCTURE:
    my-plugin/
    ├── openclaw.plugin.json    # Required: Plugin manifest
    ├── package.json            # Required: Node.js package info
    ├── index.ts                # Entry point
    └── src/                    # Source code

    openclaw.plugin.json format:
        {
            "id": "my-plugin",
            "name": "My Plugin",
            "description": "Plugin description",
            "configSchema": {
                "type": "object",
                "properties": {}
            }
        }

    package.json required fields:
        {
            "name": "@openclaw/my-plugin",
            "version": "1.0.0",
            "openclaw": {
                "extensions": ["./dist/index.js"]
            }
        }

INSTALLATION DIRECTORY:
    Plugins are installed to: ~/.openclaw/extensions/<plugin-id>/

CONFIGURATION:
    Install records are stored in: ~/.openclaw/openclaw.json
    
    {
        "plugins": {
            "allow": ["my-plugin", "other-plugin"],
            "installs": {
                "my-plugin": {
                    "source": "path",
                    "sourcePath": "/path/to/source",
                    "installPath": "~/.openclaw/extensions/my-plugin",
                    "version": "1.0.0"
                }
            }
        }
    }

ALLOWLIST (plugins.allow):
    If plugins.allow is defined, only listed plugins will be loaded.
    This script automatically:
    - Adds plugin to allowlist when installing (if allowlist exists)
    - Removes plugin from allowlist when uninstalling

SEE ALSO:
    openclaw plugins install --help
    openclaw plugins uninstall --help
    openclaw plugins list

EOF
}

main() {
    local command="${1:-help}"
    
    case "$command" in
        install)
            if [[ $# -lt 2 ]]; then
                msg_error "Missing plugin path"
                echo "Usage: $0 install <plugin-path> [--link]"
                exit 1
            fi
            local link_mode="false"
            if [[ "${3:-}" == "--link" ]] || [[ "${2:-}" == "--link" ]]; then
                link_mode="true"
                [[ "${2:-}" == "--link" ]] && shift
            fi
            install_plugin "$2" "$link_mode"
            ;;
        upgrade)
            if [[ $# -lt 2 ]]; then
                msg_error "Missing plugin path"
                echo "Usage: $0 upgrade <plugin-path> [--link]"
                exit 1
            fi
            local link_mode="false"
            if [[ "${3:-}" == "--link" ]] || [[ "${2:-}" == "--link" ]]; then
                link_mode="true"
                [[ "${2:-}" == "--link" ]] && shift
            fi
            upgrade_plugin "$2" "$link_mode"
            ;;
        uninstall)
            if [[ $# -lt 2 ]]; then
                msg_error "Missing plugin ID"
                echo "Usage: $0 uninstall <plugin-id>"
                exit 1
            fi
            uninstall_plugin "$2"
            ;;
        list)
            list_plugins
            ;;
        build)
            build_plugin
            ;;
        package)
            package_plugin
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            msg_error "Unknown command: $command"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
