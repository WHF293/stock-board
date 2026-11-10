<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import MenuIcon from '../../ui/MenuIcon.vue';
import type { TzzbAccount, TzzbAccountKind, TzzbSyncMeta } from '../../../../common/types/tzzb.types.ts';

/**
 * 投资账本顶栏：账户选择器（分组下拉）+ 同步状态 + 同步/授权操作菜单
 *
 * 账户分组：汇总（全部同步账户）/ 券商（stock）/ 两融（rzrq）/ 手工记账（manual）/ 基金（fund）；
 * 列表仅展示用户勾选的同步账户（勾选弹窗维护，2026-11-10 王总指定）；
 * 同步与授权操作统一收进右侧高光玻璃按钮的下拉菜单（同日指定布局）：
 * 同步投资账本 / 自动增量同步 / 选择同步账户 / 更新账户列表 / 重新授权 / 清空授权信息
 */
const props = defineProps<{
  /** 账户列表（股票类在前；仅展示用户勾选的同步账户） */
  accounts: TzzbAccount[];
  /** 当前选中账户 id；'' = 全部账户 */
  selectedId: string;
  /** 同步状态 */
  syncMeta: TzzbSyncMeta | null;
  /** 同步中 */
  syncing?: boolean;
  /** 更新账户列表进行中（菜单项禁用 + 文案切换） */
  refreshingAccounts?: boolean;
}>();

const emit = defineEmits<{
  /** 选中账户变化（'' = 全部账户） */
  select: [accountId: string];
  /** 点击同步 */
  sync: [];
  /** 重新授权（拉起浏览器 OAuth 流程） */
  reauth: [];
  /** 清空本地授权信息（凭据文件 registration/tokens 一并删除） */
  clearAuth: [];
  /** 打开同步账户勾选弹窗（多选确认参与同步的账户） */
  selectAccounts: [];
  /** 强制更新账户列表（绕过缓存重拉上游） */
  refreshAccounts: [];
}>();

/** 下拉开关 */
const menuOpen = ref(false);

/** 同步/授权操作菜单开关（高光玻璃按钮） */
const settingsOpen = ref(false);

/** 操作菜单项形态（action 缺省 = 未开放占位，仅展示） */
interface TzzbMenuItem {
  /** 菜单项 key（v-for 用） */
  key: string;
  /** 菜单项标题 */
  label: string;
  /** 菜单项说明 */
  desc: string;
  /** 实际操作（缺省 = 未开放占位） */
  action?: 'sync' | 'reauth' | 'clearAuth' | 'selectAccounts' | 'refreshAccounts';
  /** 危险操作（标题用警示色） */
  danger?: boolean;
  /** 进行中标记（更新账户列表刷新中禁用 + 文案切换） */
  busy?: boolean;
}

/** 同步/授权菜单项 */
const SETTINGS_ITEMS = computed<readonly TzzbMenuItem[]>(() => [
  { key: 'sync', label: '同步投资账本', desc: '拉取账户 / 持仓 / 流水全量数据', action: 'sync' },
  { key: 'auto', label: '自动增量同步', desc: '每日收盘后按水位增量拉取' },
  { key: 'select', label: '选择同步账户', desc: '勾选参与同步的账户（多选）', action: 'selectAccounts' },
  {
    key: 'refresh',
    label: props.refreshingAccounts ? '更新账户列表中…' : '更新账户列表',
    desc: '账户有变动时从投资账本重新拉取',
    action: 'refreshAccounts',
    busy: props.refreshingAccounts,
  },
  { key: 'reauth', label: '重新授权', desc: '授权到期后重新走 OAuth 流程', action: 'reauth' },
  {
    key: 'clear',
    label: '清空授权信息',
    desc: '删除本地凭据，下次授权重新注册',
    action: 'clearAuth',
    danger: true,
  },
]);

/** 账户类型 → 分组标题 */
const GROUP_LABEL: Record<TzzbAccountKind, string> = {
  stock: '券商账户',
  rzrq: '两融账户',
  manual: '手工记账',
  fund: '基金账户',
};

/** 分组顺序（rzrq 无账户时隐藏该组） */
const GROUP_ORDER: readonly TzzbAccountKind[] = ['stock', 'rzrq', 'manual', 'fund'];

/** 分组后的账户（保序） */
const groups = computed(() =>
  GROUP_ORDER.map((kind) => ({
    kind,
    label: GROUP_LABEL[kind],
    list: props.accounts.filter((a) => a.kind === kind),
  })).filter((g) => g.list.length > 0),
);

/** 选中账户（'' = 全部） */
const selected = computed(
  () => props.accounts.find((a) => a.id === props.selectedId) ?? null,
);

/**
 * 选中账户
 * @param account 账户（null = 全部账户）
 */
const pick = (account: TzzbAccount | null): void => {
  menuOpen.value = false;
  emit('select', account?.id ?? '');
};

/**
 * 点击操作菜单项：有 action 的派发事件，占位项仅收起菜单
 * @param item 被点击的菜单项
 */
const onMenuPick = (item: TzzbMenuItem): void => {
  if (item.busy) return;
  settingsOpen.value = false;
  if (item.action === 'sync') emit('sync');
  else if (item.action === 'reauth') emit('reauth');
  else if (item.action === 'clearAuth') emit('clearAuth');
  else if (item.action === 'selectAccounts') emit('selectAccounts');
  else if (item.action === 'refreshAccounts') emit('refreshAccounts');
};

/**
 * 点击外部关闭两个下拉
 * @param e 文档点击事件
 */
const onOutside = (e: MouseEvent): void => {
  const target = e.target as HTMLElement;
  if (!target.closest('[data-tzzb-picker]')) menuOpen.value = false;
  if (!target.closest('[data-tzzb-settings]')) settingsOpen.value = false;
};
onMounted(() => document.addEventListener('click', onOutside));
onBeforeUnmount(() => document.removeEventListener('click', onOutside));
</script>

<template>
  <div class="flex shrink-0 items-center gap-3">
    <!-- 账户选择器 -->
    <div data-tzzb-picker class="relative">
      <button
        type="button"
        class="pressable flex items-center gap-2 rounded-lg bg-flat-weak px-3 py-1.5 text-sm active:scale-[0.98]"
        aria-haspopup="listbox"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <span class="h-2 w-2 rounded-full bg-primary" />
        <span class="font-medium text-text">{{ selected?.name ?? '全部账户' }}</span>
        <span class="text-xs text-text-tertiary">
          {{ selected ? GROUP_LABEL[selected.kind] : '已选同步账户' }}
        </span>
        <MenuIcon
          name="chevronDown"
          :size="14"
          class="text-text-tertiary transition-transform"
          :class="menuOpen ? 'rotate-180' : ''"
        />
      </button>

      <!-- 分组下拉 -->
      <div
        v-if="menuOpen"
        class="absolute left-0 top-[calc(100%+6px)] z-30 max-h-96 w-72 overflow-y-auto rounded-xl bg-surface p-1.5 shadow-island"
        role="listbox"
      >
        <button
          type="button"
          role="option"
          :aria-selected="selectedId === ''"
          class="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm hover:bg-flat-weak"
          :class="selectedId === '' ? 'bg-primary-weak font-medium text-primary' : 'text-text'"
          @click="pick(null)"
        >
          <span>全部同步账户</span>
          <span class="font-mono text-xs text-text-tertiary">{{ accounts.length }} 个</span>
        </button>
        <template v-for="group in groups" :key="group.kind">
          <p class="px-2.5 pb-0.5 pt-2 text-xs text-text-tertiary">{{ group.label }}</p>
          <button
            v-for="account in group.list"
            :key="account.id"
            type="button"
            role="option"
            :aria-selected="selectedId === account.id"
            class="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm hover:bg-flat-weak"
            :class="
              selectedId === account.id
                ? 'bg-primary-weak font-medium text-primary'
                : 'text-text'
            "
            @click="pick(account)"
          >
            <span class="truncate">{{ account.name }}</span>
            <span class="font-mono text-xs text-text-tertiary">{{ account.id }}</span>
          </button>
        </template>
      </div>
    </div>

    <div class="flex-1" />

    <!-- 同步状态 -->
    <div class="text-right leading-5">
      <p class="text-xs text-text-secondary">
        上次同步 <b class="font-semibold text-text">{{ syncMeta?.lastSyncLabel ?? '—' }}</b>
      </p>
      <p class="text-xs text-text-tertiary">{{ syncMeta?.authExpireLabel ?? '' }}</p>
    </div>

    <!-- 同步/授权操作菜单（高光玻璃按钮触发） -->
    <div data-tzzb-settings class="relative">
      <button
        type="button"
        class="pressable pc-nav-bubble flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm active:scale-[0.98]"
        :class="settingsOpen ? 'text-text' : 'text-text-secondary'"
        aria-haspopup="menu"
        :aria-expanded="settingsOpen"
        title="账本 MCP 设置（同步 / 重新授权 / 清空授权信息）"
        @click="settingsOpen = !settingsOpen"
      >
        <MenuIcon name="settings" :size="15" />
        <span class="whitespace-nowrap">账本 MCP 设置</span>
        <MenuIcon
          name="chevronDown"
          :size="12"
          class="text-text-tertiary transition-transform"
          :class="settingsOpen ? 'rotate-180' : ''"
        />
      </button>
      <div
        v-if="settingsOpen"
        class="absolute right-0 top-[calc(100%+6px)] z-30 w-72 rounded-xl bg-surface p-1.5 shadow-island"
        role="menu"
      >
        <button
          v-for="item in SETTINGS_ITEMS"
          :key="item.key"
          type="button"
          role="menuitem"
          class="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-flat-weak disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
          :disabled="(item.action === 'sync' && syncing) || item.busy === true"
          @click="onMenuPick(item)"
        >
          <p class="flex items-center gap-2 text-sm" :class="item.danger ? 'text-up' : 'text-text'">
            <span>{{ syncing && item.action === 'sync' ? '同步中…' : item.label }}</span>
            <span
              v-if="!item.action"
              class="rounded-sm bg-flat-weak px-1 py-px text-[10px] text-text-tertiary"
            >未开放</span>
          </p>
          <p class="text-xs text-text-tertiary">{{ item.desc }}</p>
        </button>
      </div>
    </div>
  </div>
</template>
