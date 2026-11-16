/**
 * 日 K 涨跌停蜡烛覆盖标记（涨停黄柱 / 跌停灰柱）常量
 *
 * 实现：klinecharts 自定义主图指标 LIMIT_MARK（见 indicators/custom-indicators.ts），
 * 对判定为涨跌停收盘的 bar 用整根覆盖矩形重绘蜡烛颜色。
 */

/** 涨跌停覆盖蜡烛的 klinecharts 指标名 */
export const LIMIT_MARK_INDICATOR = 'LIMIT_MARK';

/** 涨停日整根蜡烛覆盖色（黄，王总 2026-11-16 指定） */
export const LIMIT_UP_BAR_COLOR = '#facc15';

/** 跌停日整根蜡烛覆盖色（灰，王总 2026-11-16 指定） */
export const LIMIT_DOWN_BAR_COLOR = '#6b7280';

/**
 * 涨停价取整半宽：涨停价 = 四舍五入(昨收 × (1 ± ratio), 0.01)，
 * 取整带来的实际涨跌幅相对偏差上界 = 0.005 / 昨收价。
 * 前复权序列按比例缩放涨跌幅不变，该判据对复权前后同样成立
 */
export const LIMIT_PRICE_ROUND_TOLERANCE = 0.005;

/** 收盘 = 最高 / 最低 的浮点相等判据（相对误差；复权系数对同 bar 内各价一致，理论上是严格相等） */
export const LIMIT_PRICE_EQUAL_EPSILON = 1e-6;

/** 沪深主板涨跌停幅度（ST 为 5%，名称信息不在 K 线序列里，暂不区分） */
export const LIMIT_RATIO_MAIN_BOARD = 0.1;

/** 创业板（30x）/ 科创板（68x）涨跌停幅度 */
export const LIMIT_RATIO_GEM_STAR = 0.2;

/** 北交所涨跌停幅度 */
export const LIMIT_RATIO_BSE = 0.3;
