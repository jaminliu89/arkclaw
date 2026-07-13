---
name: skills-index
description: Hermes Skills 中文索引菜单。加载此 skill 时自动显示全部分类索引，方便查找相关 skill。更新频率：每天凌晨自动刷新。
---

# 📋 Hermes Skills 中文索引

> 本 skill 管理 skills 的中文索引。加载后会返回索引文件内容。

## 使用方式

- `skill_view(name='skills-index')` — 查看完整索引
- `skill_view(name='skills-index', file_path='references/index.md')` — 查看索引文件

## 索引更新

索引由脚本 `~/.hermes/scripts/skills-index.py` 自动生成。

**手动更新：**
```
python3 ~/.hermes/scripts/skills-index.py
```

**自动更新：** 每天凌晨 3:30 自动刷新（已设置 cron）。

## 你常用的 skill 快速入口

| 领域 | Skill | 用途 |
|------|-------|------|
| 内容策略 | `biz-mastermind` | 人设/矩阵/涨粉/变现 |
| 内容策划 | `story-lens` | 选题/脚本/分镜/金句 |
| 写作执行 | `expert-writing-troupe` | 8 专家写作流水线 |
| 写作润色 | `diction-polisher` | 文字净化/升华 |
| 话题扫描 | `topic-agent` | 趋势扫描+选题生成 |
| 全自动流水线 | `media-pipeline` | 7 步自动化 |
| 口播/重启 | `top-operator` | 账号诊断+重启方案 |
| 本地 RAG | `vault-rag` | Obsidian 知识库问答 |
| 合同审核 | `legal-advisor` | 法律咨询+合同审查 |
| 社媒发布 | `content-publisher` | 多平台发布 |

## 完整分类索引

见 `references/index.md`

## 库维护规范

新增/修改 skill 时的组织惯例、关联写法、索引更新流程见：

- `references/library-conventions.md` — Skill 库组织规范（三层分工、关联写法、新增检查清单）
