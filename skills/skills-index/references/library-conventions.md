# Skill 库组织规范

本文件记录 Hermes skill 库的组织惯例，确保所有 skill 之间的关联一致、可发现。

## 三层分工架构（内容创作线）

用户的内容创作工作流按三层组织，每层一个 skill：

| 层级 | Skill | 职责 |
|------|-------|------|
| 策略层 | `biz-mastermind` | 人设设计、内容矩阵、涨粉路径、变现模式 |
| 策划层 | `story-lens` | 单条内容选题、脚本结构、分镜清单、金句 |
| 执行层 | `expert-writing-troupe` | 文案写作、审核、润色、格式化 |

关系：策略 → 策划 → 执行，上游定方向，下游出产品。

## 关联 skill 写法

每个 SKILL.md 底部应有 `## 关联 skill` 小节，格式：

```markdown
## 关联 skill

本 skill 专注**单条内容的生产执行**（选题→脚本→分镜→金句）。完整 skill 索引见 `skills-index`。

三层分工：`biz-mastermind`（账号策略）→ `story-lens`（内容策划）→ `expert-writing-troupe`（写作执行）
```

规则：
- 只列直接上下游，不列所有相关
- 用 **加粗** 标出本 skill 的专注范围
- 如有三层分工，用 `→` 箭头标明流向
- 末尾指向 `skills-index` 作为完整索引入口

## 索引维护

- 索引由 `~/.hermes/scripts/skills-index.py` 自动生成
- 手动刷新：`python3 ~/.hermes/scripts/skills-index.py`
- 自动刷新：每天凌晨 3:30 cron
- 新增/删除 skill 后应手动刷新一次确保索引最新

## 新增 skill 时的检查清单

- [ ] 确定所属分类（对照 `skills-index` 的分类列表）
- [ ] 检查是否可合并到现有 skill（避免碎片化）
- [ ] 如果和某 skill 是上下游关系，双方都加 `关联 skill` 引用
- [ ] 刷新索引：`python3 ~/.hermes/scripts/skills-index.py`
- [ ] 如果新增的是高频 skill，更新 `skills-index/SKILL.md` 的快速入口表
