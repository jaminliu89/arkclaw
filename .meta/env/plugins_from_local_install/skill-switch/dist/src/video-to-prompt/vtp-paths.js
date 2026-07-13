import os from "node:os";
import path from "node:path";
// VTP_HOME layout (mirrors ~/.cua):
//
// <VTP_HOME>/
// ├── config/
// │   ├── default.json        (seeded from skill package on install)
// │   └── local.json          (user overrides, optional)
// └── runs/<recordingId>/
//     ├── video.mp4
//     ├── video.mp4.log
//     ├── prompt.json
//     ├── prompt.json.bak
//     ├── meta.json
//     ├── steps.jsonl
//     ├── events.jsonl
//     ├── cua-run.log
//     ├── frames/keyframe_*.jpg
//     └── chunks/chunk_*.mp4
//
// Resolution order for VTP_HOME:
//   1. api.config.videoToPrompt.vtpHome   (openclaw.plugin.json override, namespaced)
//   2. process.env.VTP_HOME               (runtime env, e.g. for multi-user install)
//   3. $HOME/.vtp                         (default)
const DEFAULT_VTP_HOME_LEAF = ".vtp";
export function resolveVtpHome(api) {
    const cfg = api?.config
        ?.videoToPrompt;
    const fromCfg = typeof cfg?.vtpHome === "string" && cfg.vtpHome.trim() ? cfg.vtpHome : null;
    const fromEnv = typeof process.env.VTP_HOME === "string" && process.env.VTP_HOME.trim()
        ? process.env.VTP_HOME
        : null;
    const home = fromCfg ?? fromEnv ?? path.join(os.homedir(), DEFAULT_VTP_HOME_LEAF);
    return path.resolve(home);
}
export function vtpRunsRoot(api) {
    return path.join(resolveVtpHome(api), "runs");
}
export function vtpRunDir(recordingId, api) {
    return path.join(vtpRunsRoot(api), recordingId);
}
export function vtpVideoPath(recordingId, api) {
    return path.join(vtpRunDir(recordingId, api), "video.mp4");
}
export function vtpPromptDir(recordingId, api) {
    return path.join(vtpRunDir(recordingId, api), "prompt");
}
//# sourceMappingURL=vtp-paths.js.map