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
