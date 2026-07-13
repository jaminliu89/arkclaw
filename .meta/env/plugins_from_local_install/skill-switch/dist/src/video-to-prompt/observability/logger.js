// VTP 二期 P4 结构化日志 helper (ADR-0028,2026-05-21 amended)。
//
// 写滚动文件到 /var/log/openclaw_plugins/vtp/:
//   - 文件名 vtp-<YYYY-MM-DD-HH>.log,每小时一个新文件
//   - 单文件 > 10MB → 同小时内按 -1 / -2 … 递增续写
//   - 行格式 [vtp][rid=<rid>][phase=<phase>] {json},OneAgent 按
//     /var/log/openclaw_plugins/**/*.log glob 采集
// plugin 与 runtime SEA 是各自独立进程,各自打开 / 滚动文件写同一目录;
// appendFileSync 用 O_APPEND,整行 write 跨进程交错安全。
//
// 兜底配额(ADR-0028 amendment):正常采集 / 轮转老化由 OneAgent 等运维工具
// 负责;本模块只额外做两道**硬上限保护** —— ① vtp-*.log 总量超过 2GB 时
// 删最旧文件直到回落;② mtime 超过 14 天的文件直接删(与 ① 独立,低写入
// 量下旧日志也能按时老化)。防采集滞后 / 磁盘堆积。节流最多每 60s 一次。
//   注:plugin 与 runtime 各自独立进程、各自独立节流 enforceQuota,共写同
//   目录时配额是 per-process 近似 —— 最坏两进程各自判超限、over-delete 至多
//   ~2x。可接受:都是 best-effort 旧日志清理,真值由 OneAgent 轮转兜底。
//
// 日志目录不可写(本地 dev 无 root)时 fail-open 降级 stderr;测试环境
// (VITEST)静默,不写文件、不污染测试 stdout。绝不抛错拖垮业务流。
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, } from "node:fs";
import * as path from "node:path";
// 路径写死(不读 env)—— VTP_LOG_DIR 环境变量可被注入恶意路径(日志写到
// 别处 + 2GB 配额的 unlinkSync 会在攻击者指定目录删 vtp-*.log)。无 env
// 输入即无注入面,比 allowlist/realpath 校验更简单彻底。
const LOG_DIR = "/var/log/openclaw_plugins/vtp";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2GB 兜底硬上限
const MAX_AGE_DAYS = 14;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000; // 14 天时间留存上限
const QUOTA_CHECK_INTERVAL_MS = 60_000;
function prefix(ctx) {
    const parts = ["[vtp]"];
    if (ctx?.rid)
        parts.push(`[rid=${ctx.rid}]`);
    if (ctx?.phase)
        parts.push(`[phase=${ctx.phase}]`);
    if (ctx?.span)
        parts.push(`[span=${ctx.span}]`);
    return parts.join("");
}
// YYYY-MM-DD-HH（本地时间）— 每小时滚动的基础文件名。
function hourStamp(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}`;
}
// 选当前应写入的文件:同小时第一个文件 vtp-<stamp>.log;若已 ≥ 10MB
// 则 -1 / -2 … 顺延到第一个未满(或不存在)的文件。
function resolveLogFile() {
    const stamp = hourStamp(new Date());
    for (let seq = 0;; seq++) {
        const name = seq === 0 ? `vtp-${stamp}.log` : `vtp-${stamp}-${seq}.log`;
        const file = path.join(LOG_DIR, name);
        try {
            if (statSync(file).size < MAX_BYTES)
                return file;
        }
        catch {
            return file; // ENOENT — 用这个新文件
        }
    }
}
let lastQuotaCheckMs = 0;
// 兜底配额:vtp-*.log 总量超 2GB → 按文件名(含时间戳,字典序即时间序)
// 删最旧,直到回落到上限内。节流:最多每 60s 跑一次。best-effort,任何
// 失败静默 —— 配额保护不能拖垮日志写入本身。
function enforceQuota(currentFile) {
    const now = Date.now();
    if (now - lastQuotaCheckMs < QUOTA_CHECK_INTERVAL_MS)
        return;
    lastQuotaCheckMs = now;
    try {
        const files = readdirSync(LOG_DIR)
            .filter((f) => /^vtp-.*\.log$/.test(f))
            .sort(); // 文件名前缀 vtp-YYYY-MM-DD-HH 字典序 = 时间序
        const sized = files.map((f) => {
            try {
                const st = statSync(path.join(LOG_DIR, f));
                return { f, size: st.size, mtimeMs: st.mtimeMs, deleted: false };
            }
            catch {
                return { f, size: 0, mtimeMs: now, deleted: false };
            }
        });
        // C-I3: 跳过当前正在写入的文件 —— enforceQuota 紧跟 appendFileSync,该
        // 文件刚被写;删它只会被下次写重建,极端单文件超限时反复 churn。
        const tryDelete = (x) => {
            if (x.deleted)
                return;
            if (currentFile && path.join(LOG_DIR, x.f) === currentFile)
                return;
            try {
                unlinkSync(path.join(LOG_DIR, x.f));
                x.deleted = true;
            }
            catch {
                // 文件可能被另一进程删了 / 正在写 — 跳过
            }
        };
        // Pass 1: 时间留存 —— mtime 早于 MAX_AGE_MS(默认 14 天)的文件直接删。
        // 与 2GB 配额独立:低写入量下旧日志也能按时老化。
        const ageCutoff = now - MAX_AGE_MS;
        for (const x of sized) {
            if (x.mtimeMs < ageCutoff)
                tryDelete(x);
        }
        // Pass 2: 2GB 兜底硬上限 —— 剩余文件按文件名时间序删最旧。
        let total = sized.reduce((s, x) => (x.deleted ? s : s + x.size), 0);
        for (const x of sized) {
            if (total <= MAX_TOTAL_BYTES)
                break;
            if (x.deleted)
                continue;
            tryDelete(x);
            if (x.deleted)
                total -= x.size;
        }
    }
    catch {
        // readdir 失败(目录不存在等)— 静默
    }
}
let dirReady = false;
function writeLine(line) {
    // 测试环境静默:不写文件、不污染 vitest stdout。断言 vtpLog 的测试
    // 走 vi.mock("./observability/logger.js"),不依赖真实写入。
    if (process.env.VITEST)
        return;
    try {
        if (!dirReady) {
            mkdirSync(LOG_DIR, { recursive: true });
            dirReady = true;
        }
        const currentFile = resolveLogFile();
        appendFileSync(currentFile, `${line}\n`);
        enforceQuota(currentFile);
    }
    catch {
        // fail-open:日志目录不可写(本地 dev)→ 降级 stderr,不抛。
        try {
            process.stderr.write(`${line}\n`);
        }
        catch {
            // stderr 也不可用 — 彻底放弃,绝不影响业务流
        }
    }
}
function emit(level, ctx, fields) {
    writeLine(`${prefix(ctx)} ${JSON.stringify({ level, ...fields })}`);
}
export const vtpLog = {
    info(ctx, fields) {
        emit("info", ctx, fields);
    },
    warn(ctx, fields) {
        emit("warn", ctx, fields);
    },
    error(ctx, fields) {
        emit("error", ctx, fields);
    },
    debug(ctx, fields) {
        emit("debug", ctx, fields);
    },
};
//# sourceMappingURL=logger.js.map