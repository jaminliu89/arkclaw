// VTP relay-state.json 持久化模块(F-A saveVideoToMount)。
//
// 单 recording 一份 relay-state.json,落盘在 $VTP_HOME/runs/<rid>/relay-state.json。
// pending → completed/failed 有限状态机,sweepInterruptedRelays 在 plugin
// 启动时把残留 pending 标 failed RESTART_INTERRUPTED(ADR-0025 + spec
// "启动扫描 pending → failed")。
//
// 沿用 PATTERN P-04 tmp+rename 防 torn JSON —— rename 原子性保证 reader 永远
// 读到完整旧值或完整新值。注:P-04 只解决"读到半截"(atomicity),不含
// fsync,不保证掉电后新值已落盘(durability);relay-state.json 是可重建的
// 进度快照,不需要 helpers.ts atomicWriteFileWithSync 那级别的崩溃持久化。
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const FILE = "relay-state.json";
function relayStatePath(vtpHome, rid) {
    return path.join(vtpHome, "runs", rid, FILE);
}
/**
 * R-Coco H2 (ADR-0018): `$VTP_HOME/runs/<rid>/` 中间路径 symlink 防护。
 *
 * fs.readFile / writeFile / mkdir 只拒末段 symlink — 中间段 (`runs`、
 * `runs/<rid>`) 仍会被穿越。若 `runs/<rid>` 是 symlink 指向攻击者可控目录,
 * 伪造的 relay-state.json 能让下游 save-video-to-mount 的 fs.unlink 删错
 * 文件。逐段 lstat:已存在的段必须是真目录且非 symlink;ENOENT 段放过
 * (writeRelayState 的 mkdir -p 兜底创建,新录制首次 relay 时目录尚不存在)。
 * rid 先过 `^[A-Za-z0-9_-]+$` 白名单 — generateRecordingId 产出
 * `rec_<unix-seconds>_<12-hex>`,全部命中;同时挡掉 `../` 路径穿越。
 *
 * F-9 (review V5): vtpHome 自身也作 lstat 防护。生产路径
 * (resolveVtpHome → /root/.vtp) 是 root-controlled 可信路径,zero impact;
 * dev 环境若 $VTP_HOME 自定义到 symlink,这道防护拒写避免绕过整条 mount-relay
 * 符号链接拦截链。属 belt-and-suspenders 加固。
 */
async function assertSafeRunDir(vtpHome, rid) {
    if (!/^[A-Za-z0-9_-]+$/.test(rid))
        return false;
    const runsRoot = path.join(vtpHome, "runs");
    for (const seg of [vtpHome, runsRoot, path.join(runsRoot, rid)]) {
        try {
            const st = await fs.lstat(seg);
            if (st.isSymbolicLink() || !st.isDirectory())
                return false;
        }
        catch (err) {
            if (err.code === "ENOENT")
                continue;
            return false;
        }
    }
    return true;
}
/**
 * Read relay-state.json. ENOENT → init/keepVideoOnMount=false 兜底(spec:
 * "老录制无 relay-state.json → videoRelayStatus=not_enabled")。
 * 其它 IO 错误抛出供调用方记日志。
 */
export async function readRelayState(vtpHome, rid) {
    // R-Coco H2: 不安全 run dir(symlink / 非法 rid)降级为 init 兜底 —
    // 与 ENOENT 同语义(not_enabled),不读穿越后的文件。
    if (!(await assertSafeRunDir(vtpHome, rid))) {
        return { status: "init", keepVideoOnMount: false };
    }
    try {
        const raw = await fs.readFile(relayStatePath(vtpHome, rid), "utf-8");
        return JSON.parse(raw);
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { status: "init", keepVideoOnMount: false };
        }
        throw err;
    }
}
/**
 * Atomic write relay-state.json via tmp+rename (P-04). 调用方负责保证
 * runs/<rid>/ 父目录存在 — 我们 mkdir -p 兜底以防 sweep 场景下 run 目录尚未
 * 创建。
 */
export async function writeRelayState(vtpHome, rid, state) {
    // R-Coco H2: 写前 gate — 不安全 run dir 时拒写,避免 mkdir -p 跟随中间
    // symlink 在 reference root 外建目录 / 落盘 relay-state.json。
    if (!(await assertSafeRunDir(vtpHome, rid))) {
        throw new Error(`relay-state: refusing to write — unsafe run dir for rid=${rid}`);
    }
    const runDir = path.join(vtpHome, "runs", rid);
    await fs.mkdir(runDir, { recursive: true });
    // R-Coco H4 / H2: assertSafeRunDir 的 lstat 与此处 mkdir + 下方 rename 之间
    // 存在 check-then-act TOCTOU —— 攻击者可在两步间把 runs/<rid> 换成 symlink。
    // 两道防护:① mkdir 后 realpath 复核,解析掉 symlink 后的真实路径必须仍
    // 等于 runs/<rid> 规范路径,否则拒写;② 之后所有 tmp / writeFile / rename
    // 一律基于 realpath 解析出的 realRunDir(而非词法 runDir)—— 即便复核之后
    // runs/<rid> 再被换 symlink,写入仍落在最初解析出的真实目录,不跟随。
    const realRunDir = await fs.realpath(runDir);
    const realRunsRoot = await fs.realpath(path.join(vtpHome, "runs"));
    if (realRunDir !== path.join(realRunsRoot, rid)) {
        throw new Error(`relay-state: refusing to write — run dir changed after safety check for rid=${rid}`);
    }
    // I-1: progress 回调可能与主流程的 writeRelayState 并发(stream pipeline
    // 每 5% 增量 throttle fire-and-forget),旧版固定 tmp 名 `.relay-state.json.tmp`
    // 会让两个 rename 互相覆盖导致 ENOENT。加 pid + 时间戳 + 随机后缀
    // 避免 tmp 路径碰撞;rename 仍是原子的(POSIX 保证)。
    // H2: tmp / rename 基于 realRunDir,不用词法 runDir。
    // F-2 (review V5): crypto.randomBytes 替代 Math.random,与 helpers.ts /
    // skill-persistence.ts 同款 atomic 写一致;O_NOFOLLOW + atomic rename 已兜
    // 底实际攻击面,本次统一是防未来 copy-paste 时漂移。
    const tmp = path.join(realRunDir, `.${FILE}.tmp.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}`);
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(tmp, path.join(realRunDir, FILE));
}
export async function safeUnlinkRelayMountVideo(rid, relay, fallbackMountPath) {
    const mountAbsolutePath = relay.mountAbsolutePath;
    const mountRelativePath = relay.mountRelativePath;
    if (relay.status !== "completed" ||
        !mountAbsolutePath ||
        !mountRelativePath ||
        !/^[A-Za-z0-9_-]+$/.test(rid) ||
        !path.isAbsolute(mountAbsolutePath)) {
        return { deleted: false, missing: false, unsafe: true };
    }
    if (!/^vtp\/\d{4}-\d{2}\/[A-Za-z0-9_-]+\.mp4$/.test(mountRelativePath)) {
        return { deleted: false, missing: false, unsafe: true };
    }
    const relativeParts = mountRelativePath.split("/");
    let rootCandidate = relay.mountRootRealPath ?? fallbackMountPath;
    if (!rootCandidate) {
        const absoluteParts = path.resolve(mountAbsolutePath).split(path.sep);
        const tail = absoluteParts.slice(-relativeParts.length);
        if (tail.join("/") === mountRelativePath) {
            rootCandidate =
                absoluteParts.slice(0, -relativeParts.length).join(path.sep) ||
                    path.parse(mountAbsolutePath).root;
        }
    }
    if (!rootCandidate || !path.isAbsolute(rootCandidate)) {
        return { deleted: false, missing: false, unsafe: true };
    }
    const expectedRelative = path.posix.join("vtp", mountRelativePath.split("/")[1], `${rid}.mp4`);
    if (mountRelativePath !== expectedRelative) {
        return { deleted: false, missing: false, unsafe: true };
    }
    if (path.basename(mountAbsolutePath) !== `${rid}.mp4`) {
        return { deleted: false, missing: false, unsafe: true };
    }
    try {
        const realRoot = await fs.realpath(rootCandidate);
        const dangerousRoots = new Set([path.parse(realRoot).root, os.homedir()]);
        if (dangerousRoots.has(realRoot)) {
            return { deleted: false, missing: false, unsafe: true };
        }
        const expectedRealDir = path.join(realRoot, ...relativeParts.slice(0, -1));
        const realDir = await fs.realpath(path.dirname(mountAbsolutePath));
        if (realDir !== expectedRealDir ||
            !realDir.startsWith(realRoot + path.sep)) {
            return { deleted: false, missing: false, unsafe: true };
        }
        const st = await fs.lstat(mountAbsolutePath);
        if (st.isSymbolicLink() || !st.isFile()) {
            return { deleted: false, missing: false, unsafe: true };
        }
        await fs.unlink(mountAbsolutePath);
        return { deleted: true, missing: false, unsafe: false };
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { deleted: false, missing: true, unsafe: false };
        }
        return {
            deleted: false,
            missing: false,
            unsafe: false,
            error: err,
        };
    }
}
/**
 * Plugin 启动钩子:扫所有 runs/<rid>/relay-state.json,把 status="pending"
 * 的标为 failed + errorCode=RESTART_INTERRUPTED(spec "启动扫描")。
 *
 * completed / failed / init 一律不动。runs 目录缺失或部分 rid 缺 relay-state
 * 时 best-effort 静默跳过,不阻塞 plugin 启动。
 */
export async function sweepInterruptedRelays(vtpHome) {
    const runsRoot = path.join(vtpHome, "runs");
    let entries = [];
    try {
        entries = await fs.readdir(runsRoot);
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { swept: 0 };
        }
        throw err;
    }
    let swept = 0;
    for (const rid of entries) {
        try {
            // R-Coco H2: readRelayState / writeRelayState 内部已 gate,但显式
            // 跳过非法 rid 让扫描意图清晰、少两次无谓 lstat。
            if (!/^[A-Za-z0-9_-]+$/.test(rid))
                continue;
            const current = await readRelayState(vtpHome, rid);
            if (current.status !== "pending")
                continue;
            const patched = {
                ...current,
                status: "failed",
                errorCode: "RESTART_INTERRUPTED",
                errorMessage: "plugin restart interrupted in-flight relay",
                completedAt: new Date().toISOString(),
            };
            await writeRelayState(vtpHome, rid, patched);
            swept += 1;
        }
        catch {
            // best-effort: 某个 rid 损坏不应阻塞其它扫描
        }
    }
    return { swept };
}
//# sourceMappingURL=relay-state.js.map