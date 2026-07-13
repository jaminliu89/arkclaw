import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * 全局 agent skills 目录。技能在生产环境中由 install/upgrade 脚本安装到
 * `<HOME>/.agents/skills`(linux 容器环境下即 `/root/.agents/skills`),与
 * workspace 维度的 `<workspaceDir>/skills` 互为补充。skill-switch 的 list /
 * switch 路径必须扫描该目录,否则会报 skill 找不到。
 */
export function resolveAgentSkillsDir() {
    return path.join(process.env.HOME || os.homedir(), ".agents", "skills");
}
function scanSkillsDir(dir, source) {
    const skills = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name.startsWith("."))
                continue;
            if (entry.name === "node_modules")
                continue;
            const skillDir = path.join(dir, entry.name);
            const skillMdPath = path.join(skillDir, "SKILL.md");
            try {
                if (fs.existsSync(skillMdPath)) {
                    let name = entry.name;
                    let description;
                    try {
                        const content = fs.readFileSync(skillMdPath, "utf-8");
                        const titleMatch = content.match(/^#\s+(.+)$/m);
                        if (titleMatch) {
                            name = titleMatch[1].trim();
                        }
                        const descMatch = content.match(/^#\s+.+\n\n(.+?)(?:\n\n|$)/s);
                        if (descMatch) {
                            description = descMatch[1].trim().slice(0, 200);
                        }
                    }
                    catch {
                    }
                    skills.push({
                        id: entry.name,
                        name,
                        description,
                        source,
                        path: skillMdPath,
                    });
                }
            }
            catch {
            }
        }
    }
    catch {
    }
    return skills;
}
export function scanSkillsFromDirectories(params) {
    const { stateDir, workspaceDir, config } = params;
    const skillMap = new Map();
    const managedSkillsDir = path.join(stateDir, "skills");
    for (const skill of scanSkillsDir(managedSkillsDir, "plugin")) {
        skillMap.set(skill.id, skill);
    }
    const workspaceSkillsDir = path.join(workspaceDir, "skills");
    for (const skill of scanSkillsDir(workspaceSkillsDir, "workspace")) {
        skillMap.set(skill.id, skill);
    }
    const projectAgentsSkillsDir = path.join(workspaceDir, ".agents", "skills");
    for (const skill of scanSkillsDir(projectAgentsSkillsDir, "workspace")) {
        skillMap.set(skill.id, skill);
    }
    // 全局 agent skills 目录:`<HOME>/.agents/skills`(生产容器即
    // `/root/.agents/skills`)。install/upgrade 脚本把可复用 skill 装到这里,
    // skill-switch list / switch 必须扫描,否则会报 skill 找不到。
    const agentSkillsDir = resolveAgentSkillsDir();
    for (const skill of scanSkillsDir(agentSkillsDir, "workspace")) {
        if (!skillMap.has(skill.id)) {
            skillMap.set(skill.id, skill);
        }
    }
    const extraDirs = config?.skills?.load?.extraDirs ?? [];
    for (const extraDir of extraDirs) {
        if (typeof extraDir !== "string")
            continue;
        for (const skill of scanSkillsDir(extraDir, "workspace")) {
            skillMap.set(skill.id, skill);
        }
    }
    return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
export function findSkillById(skills, skillId) {
    return skills.find((s) => s.id === skillId) ?? null;
}
//# sourceMappingURL=skill-discovery.js.map