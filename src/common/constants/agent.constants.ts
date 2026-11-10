/**
 * Agent 分析模块常量（方案 §3 / §5 / §6）
 *
 * 禁 enum：状态/枚举一律 `as const` + satisfies。
 */
import type { ComposerResourceKind, ModelPresetKey } from '@/common/types/agent.types';

/** agent 数据库连接串（独立分库，与交割单 stock-board.db 互不干扰） */
export const AGENT_DB_URL = 'sqlite:agent.db';

/** 会话默认标题 */
export const SESSION_DEFAULT_TITLE = '新对话';

/** 默认分组名（DB 里不存在 id=0 的组，仅作 UI 兜底；王总口径：不叫「未分组」叫「临时会话」） */
export const UNGROUPED_LABEL = '临时会话';

/** 聊天输入框起步行数（打开就是两行高） */
export const CHAT_INPUT_MIN_ROWS = 2;

/** 聊天输入框最大行数（超出后框内滚动，不再长高） */
export const CHAT_INPUT_MAX_ROWS = 5;

/** 单条消息附图压缩后最长边（像素）——多模态模型普遍重采样到 1-2K，缩了无损语义 */
export const CHAT_IMAGE_MAX_EDGE = 2048;

/** 附图压缩 JPEG 质量（0-1） */
export const CHAT_IMAGE_JPEG_QUALITY = 0.85;

/** 单条消息附图上限（张）——防误操作批量粘贴撑爆库体积与上下文 */
export const CHAT_IMAGE_MAX_COUNT = 6;

/**
 * 历史消息携带附图的条数（最近 N 条用户消息）
 *
 * 多模态消息的图片块按原尺寸计 token，全量历史带图极易超上下文（400）；
 * 更早的消息只带文本，图片语义损失由「最近对话上下文」兜底。
 */
export const CHAT_IMAGE_HISTORY_CARRY = 4;

/**
 * 专业模式系统提示词（app_setting 缺省值；profile 未自定义时回落）
 *
 * 主 agent 定位是「调度官」而非「回答者」：拆解 → 分发 → 汇总。
 * 子 agent 名与本文件的路由表一一对应，见 `builtin-subagents.ts`（改动需同步）。
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = `# 角色
你是「金融研究调度官」，一套 A 股研究系统的总调度。你的核心职责不是独自回答所有问题，而是把用户的问题**拆解**为互不重叠的子问题、**分发**给最合适的专业子 agent，再把它们的结论**合成**为一份可直接使用的答案。

# 领域边界
仅承接金融领域问题：市场行情、大盘与板块、资金流向、宏观政策与监管、外围市场、消息面与舆情、上市公司财报与基本面、技术面与量价、个股走势复盘与情景推演、投资组合与交易记录。
非金融问题（天气、编程、日常闲聊等）统一回复：「我仅能回答金融领域相关问题，请提出股票或市场方面的问题。」
判定从宽：只要与金融市场、上市公司、宏观经济、资产价格存在实质关联即承接；用户用口语提问（如「今天大盘咋样」）同样在承接范围内。宁可先承接再澄清，也不要误判拒答。

# 能力范围（先知道自己有什么）
横向（市场级）：市场走势与盘面归因、大盘与板块资金流向、国家政策与监管事件的影响传导、外围市场联动、消息面舆情、上市公司财报（年报/中报）。
纵向（个股级）：个股短线与中长线的技术面与量价、基本面与估值、历史走势复盘、驱动归因、未来情景推演。
你不具备的能力：买卖指令、目标价、仓位与止损建议、收益承诺、内幕消息、配资相关。

# 工作流程
1. **判定**：判断问题属于单一问题还是复合问题。
2. **拆解**：复合问题必须先拆成互不重叠的子问题。例「今天大盘怎么走，我持有的 X 该怎么办」→ 拆为「市场面归因」与「个股 X 的技术与基本面」，而不是笼统地一次问完。
3. **路由**：按下方路由表把每个子问题分发给对应子 agent。一次只派发一个子问题；派发描述必须具体，带上**标的、时间范围、分析维度、用户真正关心的点**（子 agent 看不到你们的对话上下文）。
4. **汇总**：收到子 agent 结论后合成为一份答案：
   - 结论先行，证据随后；
   - 交叉验证；子 agent 结论冲突时**并列呈现并说明分歧点**，不得擅自择一；
   - 关键数字标注数据时点（as-of）；
   - 不复述子 agent 原文，只提炼与用户问题直接相关的部分；
   - 末尾附合规声明。

# 路由表
| 问题特征 | 目标子 agent |
| --- | --- |
| 大盘与指数走势、板块涨跌、盘面归因、涨停池与异动、赚钱效应 | market_review_analyst |
| 资金流向：大盘资金、板块资金、个股主力资金、北向、龙虎榜、大宗交易 | capital_flow_analyst |
| 宏观政策、监管规则、财政货币政策、行业政策、事件影响传导、外围市场与外盘联动 | macro_policy_analyst |
| 消息面、热点题材、舆情、新闻对市场或个股的影响 | news_sentiment_analyst |
| 单一公司的商业模式、财务质量、财报解读、估值、竞争优势 | stock_research_analyst |
| 技术面：K 线结构、均线、指标（MA/MACD/RSI/BOLL）、量价关系、支撑压力、策略回测 | technical_analyst |
| 个股历史走势复盘、涨跌归因、未来走势情景推演 | stock_review_analyst |

若路由表中某目标当前不可用，改用可用工具自行完成该子问题，并在答案中说明；确实无法完成时如实告知缺什么，不得编造。

# 输出规范
结构：结论 → 依据（横向与纵向分开）→ 分歧与不确定 → 风险提示。
不确定就说不确定，并说明需要哪些数据才能判断。取不到数据时明确说明，不得用推测填充。

# 合规底线
所有内容仅作信息参考，不构成投资建议。严禁给出确定买卖指令、目标价与仓位建议，不编造数据，拒绝内幕消息与配资相关提问。股市有风险，投资需谨慎。`;

/** 左栏管理入口（图标 key 见 MenuIcon.ICON_PATHS） */
export const AGENT_MANAGER_ENTRIES = [
  { key: 'skills', label: 'Skills', icon: 'book' },
  { key: 'mcp', label: 'MCP', icon: 'plug' },
  { key: 'model', label: 'Model', icon: 'cpu' },
  { key: 'agents', label: 'Agents', icon: 'agent' },
] as const satisfies ReadonlyArray<{
  key: 'skills' | 'mcp' | 'model' | 'agents';
  label: string;
  icon: string;
}>;

/** 输入框斜杠命令定义（/ 唤起的候补行） */
export interface SlashCommandDef {
  /** 命令资源类别（model 是特例：选择即切换模型；compact 是特例：立即执行压缩，无二级列表） */
  key: ComposerResourceKind | 'model' | 'compact';
  /** 命令字面量（含斜杠，如 /skills；也是输入过滤的匹配串） */
  command: string;
  /** 根级展示标题 */
  title: string;
  /** 根级说明文案 */
  description: string;
  /** MenuIcon 图标 key */
  icon: string;
  /** 二级选项列表标题（compact 立即执行无二级列表，可省略） */
  optionTitle?: string;
  /** 二级空列表文案 */
  emptyText?: string;
}

/** 输入框斜杠命令（/ 唤起；行为与 + 菜单一致，见 ChatPanel 的 slash 装配） */
export const SLASH_COMMANDS = [
  {
    key: 'skill',
    command: '/skills',
    title: '技能',
    description: '强制包含技能（对话级）',
    icon: 'book',
    optionTitle: '选择技能',
    emptyText: '暂无启用的技能',
  },
  {
    key: 'mcp',
    command: '/mcp',
    title: 'MCP',
    description: '强制并入 MCP 工具（对话级）',
    icon: 'plug',
    optionTitle: '选择 MCP',
    emptyText: '暂无启用的 MCP',
  },
  {
    key: 'subagent',
    command: '/subagent',
    title: '子代理',
    description: '追加参与编排的子代理',
    icon: 'agent',
    optionTitle: '选择子代理',
    emptyText: '暂无启用的子代理',
  },
  {
    key: 'model',
    command: '/model',
    title: '模型',
    description: '切换本次对话使用的模型',
    icon: 'cpu',
    optionTitle: '切换模型',
    emptyText: '尚未配置模型，请先在 Model 管理中添加',
  },
  {
    key: 'compact',
    command: '/compact',
    title: '压缩上下文',
    description: '把会话历史压缩成摘要，释放上下文空间',
    icon: 'cpu',
  },
] as const satisfies ReadonlyArray<SlashCommandDef>;

/** 消息气泡里资源引用标签的图标映射（kind → MenuIcon key） */
export const RESOURCE_REF_ICONS: Record<ComposerResourceKind, string> = {
  skill: 'book',
  mcp: 'plug',
  subagent: 'agent',
};

/**
 * 上下文压缩摘要的系统提示词（/compact 用；独立于主 agent 提示词）
 *
 * 摘要是后续对话恢复上下文的唯一依据，硬性要求保留数字 / 代码 / 时点等
 * 具体信息，防止压缩一轮后关键事实丢失。
 */
export const COMPACT_SYSTEM_PROMPT = `# 角色
你是「对话压缩器」。你的唯一任务是把一段多轮对话压缩成一份结构化摘要，供后续对话以最小篇幅恢复等价上下文。你不是对话参与者：不回答对话里的问题、不补充对话中不存在的信息、不发表自己的观点。

# 输出结构（Markdown，四个小节）
## 背景
会话主题、涉及标的（代码）与时间范围，一段话概括。
## 关键结论
对话中已确认的事实、数据与结论逐条列出；数字带数据时点；结论冲突时并列并注明分歧点。
## 用户意图与约束
用户明确表达的目标、偏好与约束（如关注范围、输出要求）。
## 待续事项
尚未完成的分析、已提出未回答的问题、下一步动作。

# 硬性要求
- 只输出摘要本体，不要开场白、解释或对用户的称呼；
- 保留具体数字、股票代码、日期与专有名词，不得泛化或省略；
- 工具调用结果只保留对结论有支撑的关键数据；
- 全文控制在 800 字以内。`;

/** 上下文压缩的触发指令（作为最后一条用户消息发给压缩器） */
export const COMPACT_INSTRUCTION = '请按系统要求把以上对话压缩为结构化摘要。';

/** 压缩摘要注入历史时的前缀（摘要以首条 user 消息形态重建上下文，对齐 Claude Code 做法） */
export const COMPACT_HISTORY_PREFIX =
  '【历史摘要】以下是本会话此前对话的压缩摘要，其后是摘要产生后的新消息。\n';

/** 欢迎态快捷场景 chips（点击预填输入） */
export const WELCOME_SCENES = [
  { label: '标的诊断', prompt: '帮我诊断一下当前持仓，从趋势、资金、消息三个维度给出结论。' },
  { label: '资金解读', prompt: '解读一下今天大盘主力资金流向，说明结构上的含义。' },
  { label: '盘面归因', prompt: '复盘今天的盘面，给涨幅居前的板块做归因分析。' },
] as const;

/**
 * 输入框上方常驻快捷分析按钮（点击直接发送给 agent）
 *
 * 与欢迎态 chips 的区别：这里是高频刚需的一键分析（直接发送），欢迎态是探索型场景（预填）。
 * 文案要求自包含且具体：主 agent 靠它拆解路由，问题越具体派发质量越高。
 * 选择标准：发挥现有工具集强项（行情 / 资金 / 新闻 / 涨停池 / 自选股库），不依赖特定时点。
 */
export const QUICK_PROMPTS = [
  {
    label: '大盘走势',
    prompt: '今天大盘走势怎么样？结合指数表现、成交额、板块结构与涨跌分布给出归因分析。',
  },
  {
    label: '消息面汇总',
    prompt: '汇总当前市场的重要财经消息与热点题材，按利好/利空分类，指出对市场和板块的可能影响。',
  },
  {
    label: '资金流向分析',
    prompt: '分析最近 10 个交易日大盘与板块的主力资金流向，指出资金在向哪些板块迁移、与涨跌幅有无背离。',
  },
  {
    label: '涨停与情绪',
    prompt: '复盘最近的涨停股池与盘口异动，评估当前市场情绪温度和赚钱效应。',
  },
  {
    label: '自选股诊断',
    prompt: '先查询我的自选股列表，再对每只票结合走势、资金与最新消息做简要诊断，并给出后续关注建议。',
  },
] as const satisfies ReadonlyArray<{ label: string; prompt: string }>;

/** 平滑缓冲层：目标排空时间（毫秒）——突发积压期望在此时长内追平 */
export const STREAM_TARGET_DRAIN_MS = 1500;

/** 平滑缓冲层：消费 tick 间隔（毫秒） */
export const STREAM_TICK_MS = 30;

/** 平滑缓冲层：每 tick 最少消费字符（保打字感） */
export const STREAM_MIN_CHARS_PER_TICK = 1;

/** 平滑缓冲层：每 tick 最多消费字符（极端积压兜底） */
export const STREAM_MAX_CHARS_PER_TICK = 40;

/** 长任务 checkpoint 落库间隔（毫秒） */
export const RUN_CHECKPOINT_INTERVAL_MS = 5000;

/** markdown 重渲染防抖（毫秒） */
export const MARKDOWN_RENDER_DEBOUNCE_MS = 50;

/** 供应商预设模板（添加模型弹窗预填用，§6.3） */
export const MODEL_PRESETS = [
  { key: 'custom', label: '自定义', baseUrl: '', suggestedModel: '' },
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', suggestedModel: 'gpt-4o' },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    suggestedModel: 'deepseek-chat',
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    suggestedModel: 'moonshot-v1-32k',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModel: '',
  },
  { key: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', suggestedModel: '' },
] as const satisfies ReadonlyArray<{
  key: ModelPresetKey;
  label: string;
  baseUrl: string;
  suggestedModel: string;
}>;
