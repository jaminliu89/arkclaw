import type { OpenClawPluginApi } from "./types.js";
export interface InvokeSkillOptions {
    skillScriptPath: string;
    videoPath: string;
    promptDir: string;
    recordingId: string;
    extraEnv?: Record<string, string>;
    /**
     * R6 DiD-2: caller passes vtpRunsRoot so we can enforce videoPath
     * containment. videoPath ultimately becomes argv to a bash subprocess; if
     * state.json is ever poisoned with an arbitrary path the spawn must refuse
     * rather than hand it to the skill (which then reads/unlinks it).
     * Optional for backward compat; when absent only absolute/no-traversal
     * checks run.
     */
    allowedVideoRoot?: string;
    /**
     * Called when the spawned skill subprocess exits. Caller can use this to
     * close the recording status loop (e.g. mark status=failed if exit code != 0
     * and the skill never wrote a terminal status to meta.json).
     * Errors thrown inside onExit are swallowed.
     */
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void | Promise<void>;
}
export interface InvokeSkillResult {
    pid: number;
    logPath: string;
}
export declare function invokeVideoToPromptSkill(opts: InvokeSkillOptions): Promise<InvokeSkillResult>;
export declare function resolveDefaultSkillScriptPath(api: OpenClawPluginApi): string;
//# sourceMappingURL=skill-invoker.d.ts.map