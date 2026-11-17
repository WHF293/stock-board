/**
 * 同花顺「市场热点」（hot_concept）类型定义
 *
 * 数据源：news.10jqka.com.cn/app/concept_v2_api/open/api/concept/event/jtcsm/v1/event/list
 * （GET 免鉴权；上游为同花顺 App 端 H5 页 app/hot_concept 的同款数据）
 */

/** 热点关联题材（同花顺概念 / 行业指数） */
export interface HotConceptTheme {
  /** 题材 id（与 indexCode 同值） */
  id: string;
  /** 题材类型（concept = 概念） */
  type: string;
  /** 展示名 */
  showName: string;
  /** 题材指数代码 */
  indexCode: string;
  /** 市场 id */
  marketId: string;
  /** 指数名 */
  indexName: string;
  /** 板块 id（可为 null） */
  blockId: string | null;
}

/** 热点领涨股 */
export interface HotConceptTopStock {
  /** 市场 id */
  marketId: string;
  /** 6 位股票代码 */
  stockCode: string;
  /** 股票名 */
  stockName: string;
  /** 涨跌幅（百分数数值，如 29.95 = +29.95%） */
  risePercent: number;
  /** 涨停状态（1 = 涨停） */
  limitUpState: number;
  /** 上涨原因（可为 null） */
  reason: string | null;
}

/** 单条市场热点事件 */
export interface HotConceptEvent {
  /** 事件 id（二级页 detail?id= 参数） */
  eventId: string;
  /** 热点标题（新闻式标题） */
  title: string;
  /** 热度值（原始计数，如 690553） */
  heat: number;
  /** 关联题材列表 */
  themes: HotConceptTheme[];
  /** 领涨股列表 */
  topStocks: HotConceptTopStock[];
  /** 创建时间（Unix 秒） */
  createTime: number;
  /** 是否已封顶（热度封顶标记） */
  hasTopped: boolean;
  /** 投资方向（一句话口径） */
  investmentDirection: string;
}

/** 单个交易日的热点集合 */
export interface HotConceptDay {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 当日热点事件列表（顺序即二级页 index 参数） */
  eventList: HotConceptEvent[];
}

/* ---------------------------------- 详情接口 ---------------------------------- */

/**
 * 热点事件详情（event/detail 返回，题材解读数据源）
 *
 * 数据源：/app/concept_v2_api/open/api/concept/event/jtcsm/v1/event/detail?eventId=
 */
export interface HotConceptEventDetail {
  /** 事件 id */
  eventId: string;
  /** 事件标题（与清单 title 同值） */
  title: string | null;
  /** 创建时间（Unix 秒） */
  createTime: number | null;
  /** 题材解读全文（\n 分段） */
  summary: string;
  /** 题材解读逐条摘要（上游已切分） */
  summaryItems: string[];
  /** 原文链接（「详情」外链） */
  jumpUrl: string | null;
  /** 关联题材列表 */
  themes: HotConceptTheme[];
  /** 是否已封顶 */
  hasTopped: boolean | null;
  /** 投资方向（一句话口径） */
  investmentDirection: string;
  /** 关联深度专题（未启用，恒 null） */
  relatedDeepTopic: unknown | null;
}

/** 带行情的题材板块（theme/table 返回项；细分概念在 children 中递归同构） */
export interface HotConceptThemeBoard extends HotConceptTheme {
  /** 板块实时涨幅（百分数数值） */
  risePercent: number | null;
  /** 板块涨停家数（细分概念为 null） */
  limitUpCount: number | null;
  /** 板块成分股（细分概念的领涨股集合；顶层可为 null，成分取 children 汇总） */
  topStocks: HotConceptTopStock[] | null;
  /** 细分概念（type = concept-subdivision，可为 null） */
  children: HotConceptThemeBoard[] | null;
}

/** 事件级行情（event/quote 返回项；平均涨幅 + 涨停家数） */
export interface HotConceptEventQuote {
  /** 事件 id */
  eventId: string;
  /** 事件平均涨幅（百分数数值） */
  risePercent: number | null;
  /** 涨停家数 */
  limitUpCount: number | null;
}

/** 板块实时涨幅（theme/quote/increase 返回项） */
export interface HotConceptThemeIncrease {
  /** 题材 id */
  id: string;
  /** 题材类型（concept） */
  type: string;
  /** 板块实时涨幅（百分数数值） */
  risePercent: number | null;
  /** 涨停家数（可为 null） */
  limitUpCount: number | null;
}

/* ---------------- 个股标签与描述（recommend 系接口） ---------------- */

/**
 * 个股标签（get_stock_tag.tagInfoList 项；字段名按上游 bundle 逆向，缺失容错）
 *
 * 数据源：/app/concept_v2_api/open/api/concept/event/recommend/v1/get_stock_tag（POST）。
 * ⚠️ 2026-11-17 实测：该接口仅在上游关键词概念视图下由页面自身触发，体外合成调用
 * （含带 cookie 的页面内 fetch）一律 500 系统异常，属上游会话/上下文绑定；
 * 本应用调用失败时静默降级为无描述（topStocks.reason 兜底），上游恢复后自动点亮
 */
export interface HotConceptStockTag {
  /** 标签 id */
  tagId: string;
  /** 标签名（tagName / name 容错取值） */
  name: string;
}

/** 个股关联信息（描述段落；来源为公告 / 互动易问答等） */
export interface HotConceptStockAssociate {
  /** 来源（如 互动易 / 公告；可为 null） */
  associatedSource: string | null;
  /** 描述原文（互动易时为 JSON 串 {query, answer}） */
  associatedReason: string | null;
  /** 回答时间（互动易；可为 null） */
  answerTime: string | null;
}

/** 个股标签与描述（get_stock_tag 返回项，按 stockCode 对齐） */
export interface HotConceptStockTagInfo {
  /** 6 位股票代码 */
  stockCode: string;
  /** 标签列表（可为空数组） */
  tagInfoList: HotConceptStockTag[];
  /** 关联描述段落列表（可为空数组） */
  associatedInfoList: HotConceptStockAssociate[];
}
