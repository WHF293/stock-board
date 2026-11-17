import { defineStore } from 'pinia';
import { TZZB_SCOPE_CACHE_MAX, TZZB_SCOPE_CACHE_STORAGE_KEY } from '../constants/tzzb-sync.constants.ts';
import type { TzzbScopeSnapshot } from '../types/tzzb.types.ts';

/**
 * 账户口径快照缓存（tzzb.scopeCache.v1）
 *
 * 每个账户口径（含汇总 'all'）拉全量后快照到内存 + localStorage；看板再次切入
 * 直接回放快照秒开，打开软件自动增量同步在后台按水位刷新汇总快照。
 * 原逻辑散落在 TzzbDashboard 内，2026-11-11 为支撑启动自动同步收敛成独立 store
 * （组件外也能读写同一份缓存）。
 */
export const useTzzbScopeCacheStore = defineStore('tzzb-scope-cache', {
  state: () => ({
    /** 已从 localStorage 恢复（hydrate 幂等，重复调用不覆盖内存态） */
    hydrated: false,
    /** 上次聚焦口径（账户 id；'all' = 汇总；null = 从未记录，重启后默认汇总口径） */
    lastScope: null as string | null,
    /** 口径快照（key = 账户 id / 'all'） */
    entries: new Map<string, TzzbScopeSnapshot>(),
  }),

  actions: {
    /**
     * 从 localStorage 恢复缓存与上次聚焦口径（幂等；坏数据静默忽略走网络首载）
     */
    hydrate(): void {
      if (this.hydrated) return;
      this.hydrated = true;
      try {
        const raw = localStorage.getItem(TZZB_SCOPE_CACHE_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { lastScope?: string; entries?: [string, TzzbScopeSnapshot][] };
        for (const [k, v] of parsed.entries ?? []) this.entries.set(k, v);
        this.lastScope = typeof parsed.lastScope === 'string' ? parsed.lastScope : null;
      } catch {
        /* 坏数据：忽略 */
      }
    },

    /**
     * 读取某口径快照
     * @param key 口径 key（账户 id / 'all'）
     * @returns 快照；无缓存返回 null
     */
    get(key: string): TzzbScopeSnapshot | null {
      return this.entries.get(key) ?? null;
    },

    /**
     * 写入某口径快照（内存 + localStorage 一起落）
     * @param key 口径 key
     * @param snapshot 快照对象
     */
    save(key: string, snapshot: TzzbScopeSnapshot): void {
      this.entries.set(key, snapshot);
      this.persist();
    },

    /**
     * 记录当前聚焦口径（持久化；重启后恢复上次聚焦）
     * @param key 口径 key
     */
    setLastScope(key: string): void {
      this.lastScope = key;
      this.persist();
    },

    /**
     * 持久化到 localStorage（含 lastScope；超限 / 坏数据静默放弃，不影响主流程）
     */
    persist(): void {
      try {
        const entries = [...this.entries.entries()].slice(-TZZB_SCOPE_CACHE_MAX);
        localStorage.setItem(
          TZZB_SCOPE_CACHE_STORAGE_KEY,
          JSON.stringify({ lastScope: this.lastScope, entries }),
        );
      } catch {
        /* 容量超限等：放弃持久化，内存缓存仍生效 */
      }
    },
  },
});
