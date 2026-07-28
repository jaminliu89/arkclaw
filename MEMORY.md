

<!-- Imported from Hermes: MEMORY.md -->

直播话术 skill 已更新到完整体系：四大流派框架+开场5类型+收尾3方式+轻快重慢节奏+框架话术公式+接流量分级法+诊断→选型→出稿→验证→复盘闭环+56分钟逐字稿模板(分个位数/10-30人/急速流三档)。写作团规则从6条进化到23条，含黄金钩子六法、三段式结构、发布前自查清单。
§
选题自动更新规则：所有有关选题的方法论、模板、案例、数据，收到后自动更新到三环选题方法论体系（手册第十七章），不需要用户每次提醒。包括但不限于：选题技巧、开头钩子、文案结构、行业关键词库、策略卡等。

内容自动化流水线已搭建：7步（S0画像→S1采集→S2分析→S3创作→S4审核→S5加工→S6发布），3个skill（content-scanner/content-publisher/media-pipeline），融合expert-writing-troupe的写作能力。流水线目录~/.hermes/pipeline/。需安装MediaCrawler（采集）和Social-Auto-Upload/MultiPost（发布）才能全自动化。
§
vault-rag skill rebuilt and registered. Script at ~/.hermes/scripts/vault_rag.py. Uses rg + Qwen3-8b for fast (8-10s) local RAG on Obsidian vault. Command: python3 ~/.hermes/scripts/vault_rag.py query "问题" [--deep]. Alias: vq (if configured). vault_search.py is the pure rg version for keyword-only lookup.
§
Obsidian vault搜索必须用ripgrep（rg命令），不能用纯python做全量扫描（563个文件用纯python超时5分钟）。rg搜索4-8秒返回。王整理调用vault_search.py前先确认rg已安装。
§
用户极度讨厌GUI操作，任何回答提到GUI/界面/图形工具都会被他否决。他只接受终端直接回复的内容。他属于说出需求就要你立刻执行的类型，不想要解释和选项，要直接的行动和方案。
§
Novel writing vault at ~/Documents/Obsidian Vault/小说写作/ — 328 md files from 16G raw materials. 3 dirs: 讲课记录(52), 技巧方法(262), 大纲模板(14). Also 老白故事课 (11 files). Search with rg or vault_search.py, not pure Python. Created novel-writing skill covering story structure, character design, scene craft.
§
写作输出规则：文案就是纯文字，不包含[画面：...]等场景提示。画面提示属于分镜脚本，不是文案。画面感应该溶解在文字里，不是标注在旁边。这条规则优先级高于一切风格模板。
§
写作核心原则：先抽象精神内核再落笔。不按时间线走，按精神切面安排结构。找到意象承载精神，用留白代替解释。不直说情感，让意象替你说。
§
用户在多平台创建了skill：扣子(Coze)、豆包、Kimi、千问(通义)、智谱清言(GLM)、CodeBuddy CN、阶跃AI(Step)。这些平台的skill可以搬到~/.hermes/skills/下直接使用，只要没有API依赖。
§
Skill library: skills-index skill with auto-generated Chinese index (104 skills, 17 cats). Cron 3:30AM refresh. Script ~/.hermes/scripts/skills-index.py. Cross-ref convention: each SKILL.md has '关联 skill' section. Three-layer content arch: biz-mastermind(strategy) → story-lens(planning) → expert-writing-troupe(execution). Conventions doc at skills-index/references/library-conventions.md. 2 skills moved from ~/.agents/skills/ (story-lens, biz-mastermind).
§
技能索引入口：说「看菜单」即可加载 skills-index skill，展示全部104个skill的中文分类索引。自动每天凌晨3:30刷新。
§
top-operator 和 mcn-strategist 的 SKILL.md 引用路径需要从相对路径 `Obsidian Vault/运营/...` 修正为绝对路径 `/Users/kimliu/Documents/Obsidian Vault/运营/...`。已在 references/ 下添加了快速参考文件作为临时替代。下次有机会 patch 时修正。
§
铁律：禁止私自保存任何文本到文件。所有内容必须直接返回在聊天中显示。用户确认「可以保存」后才能保存到文件。违反过一次（写了vlog脚本和自我介绍到磁盘），已被用户纠正。
§
Persona auto-update: 每次获得柳俊名的新信息（年龄/家庭/经历/偏好/宠物/账号等），立即更新 ~/.hermes/pipeline/persona-card-liujunming.yaml 的 facts_verified 列表和对应字段，同步更新 memory。
§
写作核心公式：人格×笔风。人格提供真实（柳俊名的经历和感受），笔风提供工艺（写作团不同角色的手艺）。不能只用一种语调写所有东西，不能从人格画像拼凑素材当成品。每次写之前先确定：这篇需要他身上的哪个角色来发声？
§
用户账号历史：柳俊名重启中这个号以前是助理运营/用女声，因故停滞几年粉丝持续掉。现在他本人拿回亲自运营。内容方向：个人成长+摄影+AI+生活杂谈。
§
知识库搜索硬规：搜到结果必须全部打开阅读前30行再判断相关性，不能凭标题跳过。
§
知识库搜索规则：搜索返回的所有文件必须打开阅读至少前30行确认相关性。不能凭文件名或路径摘要跳过。每个文件确认无关后才能排除。
§
知识吸收铁律：用户让我学习任何内容时，先全部吸收不筛选不判断，使用时再判断哪些适用。禁止在吸收阶段过滤内容。必须读取根目录和所有子文件夹的全部文件。适用内容进化成skill，不适用内容也作为知识储备保留。
§
用户纠正必生成skill规则：每次被纠正（事实/风格/逻辑/漏加载）→ 立刻patch对应skill，不等到会话结束。如果找不到适用skill就创建。用户宁愿被patch打扰也不想下次再犯同一错误。
§
故事创作核心原则已固化在 expert-writing-troupe 规则12b/12c：阻碍越大冲突越大、每篇必须有转。先确定转折点在哪一句再动笔，转折和反转不同——转折是方向变了，反转是局面颠倒了。
§
查看文件夹时必须检查子目录。知识吸收铁律：先全部吸收不筛选不判断，使用时再判断哪些适用。禁止在吸收阶段过滤。
§
路由调度是每次输入的第一件事，先跑路由判定再创作，not凭经验跳。路由系统在 expert-writing-troupe 顶部，全景协作图在 references/skill-panorama.md。路由自动进化：用户指出漏加载skill时自动更新规则，不需手动提醒。
§
知识吸收铁律吸收存储于 writing troupe rule 7。用户要求所有学习内容先全部吸收不筛选，使用时再判断哪些适用。禁止在标题阶段过滤文件。
§
知识吸收铁律强化版：用户让我学习任何内容时，根目录+所有子文件夹每一个文件全部读取，不筛选不跳过。适用内容进化成skill，不适用也存为知识储备。
§
写作团规则已完成编号重置：1-30条连续无重复。路由系统新增第五步（自动进化机制）。live-stream-script新增饭桌状态迁移法（镜头前自然说话训练）。
§
三位创作者方法论（可复用内容策略）：导演小策=可复用容器(固定人物+场景+结构，只换内容)；东八区赵光辉=标志性结尾(固定收尾句成为账号资产)；神奇阿宇=视觉奇观(将绝对优势做成最终交付物)。来源：用户深度拆解。
§
short-viral-methodology skill (creative/): 薛辉体系(8爆款元素/词根/PREP/对立框架/千川段位). Cross-linked with top-operator, mcn-strategist, expert-writing-troupe, live-stream-script, topic-agent, media-pipeline.
§
2026-07-12 从8个DeepSeek分享链接吸收了7个实战案例（年入千万商业链路、摄影师代运营本地商家、2025直播话术、婚礼策划内容策略、义乌创业日用品批发、序列影像口播+报价、农村创业摄影+直播+亲情IP），已存入 top-operator/references/deepseek-case-studies-2026-07-12.md。第8个案例（农村创业帐篷直播+6只狗+照顾奶奶）和人设几乎镜像柳俊名。
§
2026-07-13 进化完4个skill：short-viral-methodology(新增高客单商业链路SOP第21章)、live-stream-script(新增2025直播话术趋势第8章)、expert-writing-troupe(新增婚礼/摄影/义乌/农村创业指南第31-33章)、topic-agent(新增3种角度类型FGH)。8个DeepSeek分享链接学习完毕。
§
跨会话记忆保留：Memory持久笔记和Holographic Memory跨会话保持不丢。session_search搜索所有历史会话找回上下文。切模型时尽量用hermes config set model <model>不/reset，必须/reset时新会话用session_search找回。
§
session-resume skill (productivity/) — 跨会话恢复工具。切provider+reset后说「恢复」或「续上」自动找回最近会话上下文。不依赖memory，用session_search查历史。四步流程：找会话→读上下文→查memory+fact_store→出报告。
§
今日吸收：O1思维→expert-writing-troupe规则34（推理链路+自我优化+分解策略）。Claude隐式创作→规则34.4（对比表+指导）。LangGPT编剧→规则36（动态人设+COT+Step-Back）。飞书管理系统→biz-mastermind references。夜生活商业链路SOP→top-operator通道4+references。法律AI PRD→legal-advisor双模块参考。Divide/Conquer→规则34.3来源标注。全景图同步更新+3条进化记录。
§
提供商切换流程：切火山/硅基/官方后，用户说「恢复」或「续上」会加载session-resume skill找回上下文。不依赖~/.zshrc读API key，全部key已集中管理不再分散。
§
铁律：创作任何文本时，禁止直接使用柳俊名人格画像中的原文片段（如"初中辍学""37岁重启""北漂十年"等字面表述）。人格画像只作为底层视角和语气参照，不是素材库。每个作品必须独立创造，从当前视角自然出发。除非用户明确要求查阅画像，否则不引用画像文件中的任何语句。
§
创作铁律：每次写新文本必须重新设计结构，禁止沿用上一个文本的格式/排版/骨架。上一条用了五段式+表格+速查卡，下一条就不能再用同样的骨架。每一篇根据内容本身的逻辑来定形式——有的应该是一段话流，有的是问题链，有的是具体步骤，有的就是几句观点。不要同一个模具倒所有东西。
§
格式重置铁律：每次回复前必须做格式重置——不沿用上一个回答的排版结构（表格/分段/编号）。上一个答了文档框架，下一个就该即兴就即兴、该闲聊就闲聊、该一句就一句。格式惯性 = 应付式输出。已在 expert-writing-troupe 规则0固化。
§
用户投诉：上一个回答是结构化文档，下一个自动沿用表格/框框/分段的格式惯性，不按当前需求切换。必须在每个新回答前做格式重置——按当前请求决定风格，不是沿用上一个模板。用户说「换一种写法」或「别用这种结构」时立刻切换。
§
知识吸收完成：知乎文章《Hermes Agent进阶指南：8个让你从"聊天"到"全自动干活"的隐藏玩法》(5354字)已全部吸收。核心要点包括：SOUL.md人格定义(1KB内，写行为规则非性格描述)、Memory三层/跨会话、AGENTS.md项目规则/惰性发现/.cursorrules复用、Cron挂多skill(--skill组合)/SILENT模式(监控类返回[SILENT]静默)、Skill五设计原则(单一职责/文件系统传递/幂等/可观测/容错)、Subagent并行委派/delegate_task、Prompt Cache(/compress保持缓存命中)、多平台Gateway+/sethome、OpenClaw迁移、LightRAG知识图谱。后续检查哪些要点需要进化到现有skill中。
§
RTK (Rust Token Killer) v0.43.0 installed via brew. Use rtk ls, rtk git, rtk read to replace plain ls/git/read commands — filters out noise (permissions, timestamps, headers) and saves 60-90% tokens on terminal output. NOT auto-integrated into Hermes (Claude Code hook only); must use rtk prefix manually.
§
Pandoc 3.10 installed via brew. Universal format converter for the media pipeline — handles .docx, .epub, .html, .md, and 100+ other format conversions.
§
Tavily python package installed (tavily-python 0.7.26). Needs API key from tavily.com — not yet configured. DuckDuckGo search also installed (duckduckgo_search) as free fallback.
§
Hermes Desktop 架构知识：桌面版 model picker 用 localStorage（key: hermes.desktop.composer.provider / hermes.desktop.composer.model）而非 config.yaml 的 provider/model 字段。初始为空字符串时下拉框显示空白，但 backend（hermes serve）仍读 config.yaml，实际可用。desktop.json 有三个连接模式：local（启动本地 serve）、remote（连接远程 serve）、ssh（SSH 隧道）。用户问 desktop 配置问题时加载此知识。
§
2026-07-13 用户咨询摄影变现模式：倾向于复杂路径（免费/低价抢客→搭撮合平台→线上+线下引流），被纠正为「直接接单收钱」的简单执行路径。他愿意从399/599低价单做起，先验证市场再想放大。核心矛盾：习惯用「搭平台」这类规划替代直接行动。目标月入4000-8000，摄影直接变现是比直播更近的路径。
§
expert-writing-troupe v2.11.0 — 新增创作阶段感知系统。在路由系统后、第一原则前插入完整机制：4个阶段（发散期/结构期/填充期/修改期），每个阶段有触发关键词、人格模式、行为重点、正确/错误交付物映射。影响路由第二步的技能匹配（根据阶段决定专家激活方式）。与路由自动进化联动（给错阶段时自动更新判定表）。来源：MetaSOTA动态人格切换方法论。
§
/Users/kimliu/Documents 文件盘点完成：50+文件，分7类 — 策划策略(4个重叠)，人格画像(3个冗余)，AI调教(6个冗余)，直播话术(7个冗余逐字稿)，vlog文稿(2个)，粉丝话(3个冗余)，杂项(4个独立)
§
2026-07-13 从MetaSOTA深度研究报告吸收4条洞察，已patch到3个skill：(1) expert-writing-troupe规则37「一个账号一个商业动作」——接单赛道≠博主赛道，混做=自杀，2026冷启动失败率60%第一杀手；(2) top-operator顶部新增「2026算法权重迁移·冷启动铁律」章节——收藏>回访>停留>评论>点赞（点赞已贬值）、推作者不推作品、小红书搜推融合、一机一卡一号、首周不投流、爆款2小时窗口、慢热爆款7-15天；(3) mcn-strategist Dimension5更新——补充跨平台协同黄金通道「小红书种草+抖音转化」的分工规则。
