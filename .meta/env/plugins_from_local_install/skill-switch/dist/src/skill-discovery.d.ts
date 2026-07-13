import type { SkillInfo } from "./types.js";
/**
 * 全局 agent skills 目录。技能在生产环境中由 install/upgrade 脚本安装到
 * `<HOME>/.agents/skills`(linux 容器环境下即 `/root/.agents/skills`),与
 * workspace 维度的 `<workspaceDir>/skills` 互为补充。skill-switch 的 list /
 * switch 路径必须扫描该目录,否则会报 skill 找不到。
 */
export declare function resolveAgentSkillsDir(): string;
export declare function scanSkillsFromDirectories(params: {
    stateDir: string;
    workspaceDir: string;
    config?: any;
}): SkillInfo[];
export declare function findSkillById(skills: SkillInfo[], skillId: string): SkillInfo | null;
//# sourceMappingURL=skill-discovery.d.ts.map