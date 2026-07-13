/**
 * 对话来源判定。
 *
 * 历史:
 * - v1-v3: 用 ctx.messageProvider 判定 — 黑名单 "webchat"、其他都判 IM。
 *   实测发现 openclaw 在 outbound 路径(before_prompt_build hook 所在路径)+
 *   sessionKey 存在时永远不传 messageProvider(`deliver.ts:1370` /
 *   `outbound-send-service.ts:139` / `message-action-runner.ts:1357` 都是
 *   `sessionKey ? undefined : channel` 模式)。所以 messageProvider 永远
 *   undefined,所有场景兜底为 web,IM 分支永远不触发,前 7 commits 改的
 *   SKILL.md IM 分支文案从未在真 IM channel 验证过。
 * - v4(2026-05-25): 改用 sessionKey 第三段 prefix 解析 channel name,
 *   白名单(feishu / discord / slack / telegram / wechat / ...)匹配才判 im,
 *   其他(webchat / 未知 channel / sessionKey 缺失)**兜底 web**。
 *   Web 是先有代码 + 已实测稳的分支,未识别情况走 Web 是工程基本原则
 *   (用户的明确 push back:渠道识别不上时用稳的 fallback,不要让新代码
 *   无差别接管所有 channel)。
 *
 * sessionKey 格式参考:
 *   agent:main:web-a225ff82-b39c-...    → webchat,判 web
 *   agent:main:feishu-<chat-id>          → 飞书 IM,判 im(假设上游命名)
 *   agent:main:demo-channel:group:dev    → 未知 channel,兜底 web
 *
 * 上游 channel 命名可能调整;实测发现新 channel 没识别,扩充
 * IM_CHANNEL_PREFIXES 列表即可,不动判定逻辑。
 */
/**
 * 已知 IM channel 的 sessionKey 第三段 prefix 白名单。
 * 命名对齐 openclaw `extensions/*` 目录名 + `docs/channels/*.md`。
 * 顺序无关(用最长 match);新增 channel 直接 push 到列表。
 */
const IM_CHANNEL_PREFIXES = [
    "feishu",
    "lark",
    "openclaw-lark",
    "discord",
    "slack",
    "telegram",
    "whatsapp",
    "wechat",
    "openclaw-wechat",
    "weixin",
    "openclaw-weixin",
    "line",
    "matrix",
    "mattermost",
    "signal",
    "msteams",
    "googlechat",
    "zalo",
    "zalouser",
    "imessage",
    "bluebubbles",
    "qqbot",
    "nostr",
    "yuanbao",
    "synology-chat",
    "tlon",
    "irc",
    "twitch",
    "dingtalk",
    "dingtalk-connector",
    "nextcloud-talk",
];
/**
 * 从 sessionKey 第三段提取 channel name(取最长 IM_CHANNEL_PREFIXES 匹配)。
 * 最长匹配:`openclaw-weixin-xxx` 优先匹 `openclaw-weixin`,不会被 `weixin`
 * 短前缀提前 short-circuit。
 *
 * 返回 null 表示:① sessionKey 格式不符 `agent:<scope>:<rest>`,② 第三段不
 * 以任何 IM channel prefix 开头(包括 `web-...` / 未知 channel)。
 */
function extractImChannelFromSessionKey(sessionKey) {
    const parts = sessionKey.split(":");
    if (parts.length < 3 || parts[0] !== "agent")
        return null;
    const third = parts[2].toLowerCase();
    let best = null;
    for (const p of IM_CHANNEL_PREFIXES) {
        if (third.startsWith(p) && (best == null || p.length > best.length)) {
            best = p;
        }
    }
    return best;
}
export function detectConversationSource(ctx) {
    // 主路径:sessionKey 第三段 prefix → IM 白名单。sessionKey 一旦明确提供
    // agent channel,它比 messageProvider 更可信;`agent:main:web-*` 必须稳定
    // 判 web,不能被某些外层/桥接层传入的 IM-looking provider 覆盖成 im。
    if (ctx.sessionKey) {
        if (extractImChannelFromSessionKey(ctx.sessionKey)) {
            return "im";
        }
        const parts = ctx.sessionKey.split(":");
        if (parts.length >= 3 && parts[0] === "agent") {
            return "web";
        }
    }
    // 次路径:messageProvider **必须命中 IM 白名单**才判 im(罕见;outbound
    // 路径 messageProvider 通常 undefined,inbound 路径偶尔有值)。
    //
    // 历史:v4 初版次路径用「排除法」`provider !== "webchat" && provider !== "web"`,
    // 但 openclaw 在某些场景下 messageProvider 可能设为 "openclaw-control-ui" /
    // "control-ui" / 其他非 webchat 字符串 → 被错判为 im → webchat session 走 IM
    // 分支(实测 bug)。v4.1 改为严格白名单(同主路径),只有命中 IM channel
    // prefix 才判 im,其他全部 web 兜底。
    const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
    if (provider && IM_CHANNEL_PREFIXES.some((p) => provider.startsWith(p))) {
        return "im";
    }
    // 兜底:webchat / 未识别 channel / sessionKey 缺失 / messageProvider 不在白名单
    // → Web (稳;已验证的旧 stop-handoff 路径)
    return "web";
}
/** 渲染注入 prompt 的来源标记行。 */
export function renderConversationSourceLine(source) {
    if (source !== "im") {
        return "当前对话来源:Web 兜底(webchat 或未识别渠道),按 SKILL.md 的 Web 分支回复";
    }
    // 强 imperative 完整 IM 指令(直接内联在 system prompt 顶部),让 LLM
    // 必走此路径,不依赖 SKILL.md 分支(实测 LLM 自上而下读 SKILL.md 看到
    // Web rule 在前就执行了,后面的 IM 分支被忽略)。
    return [
        "当前对话来源:IM 渠道(飞书 / 微信 / Discord / Slack 等)。",
        "用户在 IM 客户端,没有自己的浏览器/桌面可操作。下面的指令覆盖 SKILL.md 中 `Handoff Rule` 的 Web 默认行为。",
        "",
        "### IM handoff(任何 wait_for_user 场景均适用,不限登录)",
        "",
        "**触发 handoff 前先 verify 当前页面真的还需要用户配合**:跑 `bua snapshot --interactive`(或 cua 看截图)确认当前状态。如果发现已经登录成功(URL 跳到首页 / 出现用户头像 / 出现「欢迎,XXX」类登录后元素)、或任务已完成、或之前 handoff 已被用户完成,**不要再发引导文案** —— 直接续跑原任务。避免误把已完成的状态再次当作 wait_for_user 触发 handoff(实测:用户已扫码登录后,LLM 仍发「请扫码」文案的 bug)。",
        "",
        "当需要中断让用户配合时(login / CAPTCHA / QR / payment / SMS / cookie consent / 人工判断 / 用户接管 / SSO 异常 / 其他),你**必须**:",
        "",
        "1. **【硬性约束·违反即任务失败】** 首次进入 wait_for_user 或页面/桌面状态变化需要重新引导用户时,回复的**第一行必须是**:",
        "",
        "   `MEDIA:~/.openclaw/media/outbound/handoff.jpg`",
        "",
        "   **关键语义(避免误解)**:这一行是给 plugin 的**意图标记(intent marker)**,**不是引用已存在的截图文件**。plugin 看到此行后会**独立**调用 `captureFreshHandoffScreenshot()` 截当前桌面 / 浏览器画面发图,**完全不读** LLM 历史里的旧 `handoff.jpg`。所以:**无论 CUA / BUA 工具之前是否成功保存过截图,你都必须把这一行作为意图信号写出来**。CUA 报「保存失败」「转换失败」「⏸️ 任务已暂停」「browser 启动失败」之类的 prose,只是 CUA tool 内部状态,与 plugin 独立截屏路径完全无关,**不构成省略 MEDIA: 行的理由**。**唯一允许省略 MEDIA 的场景仅有用户 ack 这一种**(见本条最下方「唯一特例」),其它任何情况(含 CUA/BUA 报错、截图缺失、不确定页面状态)都必须照写 MEDIA: 行。",
        "",
        "   **自检 reminder**:开始写 wait_for_user 引导文案前,**先把 MEDIA: 行写出来**。如果你直接从 prose 开始(如「当前需要登录...」「请扫码...」),微信/Lark 等 IM 用户**收不到截图**,任务实际上 broken — 用户只看到文字,看不到二维码 / 登录界面 / CAPTCHA / 桌面状态,无法行动。**如果你看到自己的 thinking 在纠结「截图没生成 / 转换失败 / 不知道有没有图,要不要写 MEDIA」,答案永远是「写」**——这是 plugin 的意图标记,不是文件引用。",
        "",
        "   ✅ 正确格式:",
        "   ```",
        "   MEDIA:~/.openclaw/media/outbound/handoff.jpg",
        "   当前访问知乎专栏需要登录,你可以...",
        "   ```",
        "",
        "   ❌ 错误格式(LLM 实测常踩坑):",
        "   ```",
        "   当前访问知乎专栏需要登录,你可以...   ← 漏了 MEDIA 行",
        "   ```",
        "   → 微信用户收不到截图,只看到 prose,无法扫码",
        "",
        "   **唯一特例**:用户只是 ack(「我先登录」「等我一下」「好」)且无新数据/状态变化时,**不发 MEDIA**,只回「好的，完成后告诉我，我继续任务。」",
        "",
        "   **渠道行为差异**:",
        "   - 飞书/Lark:plugin 根据此 MEDIA intent 走专用 direct-send workaround 附 fresh 截图;不要依赖固定 handoff.jpg 的旧内容作为发送源",
        "   - **微信等其他 IM:没有 direct-send workaround,完全依赖此 MEDIA 行**给 openclaw 标准 MEDIA directive 链路解析并发送。**漏 MEDIA = 微信用户无图,无可挽回**",
        "   - browser-use 路径如果确实需要首次 handoff,你可以先跑 `bua screenshot` + `convert <RAW> -resize '1280x1280>' -quality 70 ~/.openclaw/media/outbound/handoff.jpg` 作为 legacy marker 准备;computer-use(CUA)路径下 plugin 会处理截图,**你只在需要首次/新状态 handoff 时写 MEDIA:**",
        "   - 不要用 `![](file://...)` markdown(被安全策略 block);只用 `MEDIA:` directive",
        "",
        "2. **预留**(legacy step number,跳过 — 直接做第 3 步)。",
        "",
        "3. **`MEDIA:` 行紧接的下一行**起,写**详细中文引导文案**,按中断类型:",
        "   - login / SMS / email 验证:命名站点和页面,列出页面上**实际可见**的登录方式(扫码 / 验证码 / 账密 / 第三方 / SSO 等),对每种方式告诉用户具体发什么数据(手机号 / 验证码 / 账号 / 密码),你替他填。",
        "   - CAPTCHA:**必须结合截图视觉判断子类**(不要凭常见类型猜),按子类分别处理:",
        "     · **文字/数字输入型**(看到输入框 + 干扰文字):让用户从截图读出字符发你,你替他输入。",
        "     · **短信/邮件验证码**:让用户把收到的码发你,你替他输入。",
        "     · **图形点击型**(「请按顺序点击图中『X』『Y』『Z』」、「点击图中的 X」):用户用文字描述点击位置不可行 → **诚实告知用户**「这类验证码无法通过 IM 精确完成,建议换扫码登录 / 短信验证码登录(回复对应方式名称我重试)」,不要让用户用文字描述图里位置。",
        "     · **滑块拖动型**(看到拖动条 + 拼图缺口):同上,无法 IM 完成,建议换登录方式。",
        "     · **行为/旋转/选择类**(如「将图中的图片旋转至正向」):同上,建议换登录方式。",
        "     · **建议换方式时排除已失败的方式**:如果用户刚才选的是「验证码登录」触发了滑块,不能再推荐「验证码登录」(用户再选还是同样的滑块);只推荐**未尝试过的其他方式**(扫码 / 账密 / 第三方等)。",
        "     · **不确定子类**:描述截图中 CAPTCHA 的视觉特征(几个输入框 / 是否有图块 / 是否有拖动条 / 是否要求点击),让用户确认,你再决定可否替他完成。",
        "   - 扫码登录 / 设备配对 / 支付确认 QR:让用户用对应 App 扫码,完成后回 你。",
        "   - 支付:让用户在自己设备/银行 App 完成,**不要**让他在 IM 发卡号/CVV;完成后回 你。",
        "   - cookie consent / 系统对话框 / 需要人工判断的弹窗:描述选项,让用户回决策。",
        "   - 用户主动接管:首次接管时简短确认 + 截图就够,让他告诉你何时继续;若用户只是中途 ack(如「我先登录」「等我一下」「好」)且无新数据/完成信号,不要重发 MEDIA,只回复「好的，完成后告诉我，我继续任务。」",
        "   - SSO loop / 不稳定流程:解释卡在哪里,问用户怎么处理(重试 / 换方式 / 中止)。",
        "   - 其他:描述当前页面/桌面状态,说明你需要什么,告诉用户怎么回。",
        "",
        "4. **绝对禁止**:",
        "   - 不要输出 `<browser-handoff />` 或 `<computer-handoff />` tag(IM 渠道不识别,会变字面字符串残留)。",
        "   - 不要用 `![](file://...)` markdown(被安全策略 block)。",
        "   - 不要用拒绝句式:「由于隐私我无法」「请你手动操作」「请到浏览器/屏幕」「为保护隐私」「考虑到安全」 —— 用户主动配合给数据是被允许的。",
        "   - 不要用 Web 风格句式「请你完成登录操作」「请在浏览器中...」(等价于让用户去看屏幕),IM 用户没浏览器/桌面。改成「把 X 数据发我,我替你填」「用手机扫一下回复我」等 assisted 句式。",
        "   - **CUA 路径专属**:当 cua_run 工具结果含「⏸️ 任务已暂停」「需要人工介入」「需要用户手动操作」「请你完成」「💡 完成操作后,使用 /cua continue」等 web/desktop 风格 prose 时,**不要**把这些 prose 原样转发或简单 paraphrase 给 IM 用户;必须**完全重写**最终 wait_for_user 文案,按本 marker 第 3 步的 9 类 IM 引导规则(assisted 句式 + 让用户发数据)。cua 工具进度的 ✅ 行可以保留(向用户报进度),但最后的中断说明必须按 IM 规则重写,不是 paraphrase cua 文本。",
        "   - echo 用户数据时 mask:手机号 `138****1111`,验证码/密码 `******`,绝不原样回放。",
        "",
        "5. 用户回数据后,你**替他填入页面/桌面并继续**(browser-use 用 `bua snapshot` + `bua fill` + `bua click`;computer-use 新启一轮 cua run 描述要点击/输入的位置)。echo 时 mask。",
    ].join("\n");
}
//# sourceMappingURL=conversation-source.js.map