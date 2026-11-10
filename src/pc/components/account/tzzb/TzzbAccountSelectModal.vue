<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BaseModal from '../../ui/BaseModal.vue';
import BaseButton from '../../ui/BaseButton.vue';
import type { TzzbAccount, TzzbAccountKind } from '../../../../common/types/tzzb.types.ts';

/**
 * 同步账户勾选弹窗（多选确认）
 *
 * 首次拉到账户列表后弹出（默认全部勾选，由用户确认同步哪些账户的数据，
 * 2026-11-10 王总指定交互）；后续可从「账本 MCP 设置 → 选择同步账户」随时改勾选。
 * 确认后勾选持久化，后续全部取数只覆盖勾选账户。
 */
const props = defineProps<{
  /** 全量账户列表（股票类在前） */
  accounts: TzzbAccount[];
  /** 当前勾选（打开时作为草稿初值） */
  selectedIds: string[];
  /** 是否首次确认（true = 文案强调"确认后开始同步数据"） */
  firstConfirm?: boolean;
}>();

const emit = defineEmits<{
  /** 确认勾选（至少 1 个，按钮已保证） */
  confirm: [ids: string[]];
}>();

const open = defineModel<boolean>('open', { required: true });

/** 勾选草稿（确认前可自由改，不影响外部状态） */
const draft = ref<Set<string>>(new Set());

// 打开时以当前勾选重置草稿（首次 = 全选由调用方传全量）
watch(open, (isOpen) => {
  if (isOpen) draft.value = new Set(props.selectedIds);
});

/** 账户类型 → 分组标题 */
const GROUP_LABEL: Record<TzzbAccountKind, string> = {
  stock: '券商账户',
  rzrq: '两融账户',
  manual: '手工记账',
  fund: '基金账户',
};

/** 分组顺序（无账户组隐藏） */
const GROUP_ORDER: readonly TzzbAccountKind[] = ['stock', 'rzrq', 'manual', 'fund'];

/** 分组后的账户（保序） */
const groups = computed(() =>
  GROUP_ORDER.map((kind) => ({
    kind,
    label: GROUP_LABEL[kind],
    list: props.accounts.filter((a) => a.kind === kind),
  })).filter((g) => g.list.length > 0),
);

/** 勾选数（确认按钮文案用） */
const checkedCount = computed(() => draft.value.size);

/** 是否全选（全选/清空切换文案用） */
const allChecked = computed(() => draft.value.size === props.accounts.length);

/**
 * 勾选 / 取消单个账户
 * @param account 目标账户
 */
const toggle = (account: TzzbAccount): void => {
  const next = new Set(draft.value);
  if (next.has(account.id)) next.delete(account.id);
  else next.add(account.id);
  draft.value = next;
};

/**
 * 全选 / 全不选切换
 */
const toggleAll = (): void => {
  draft.value = allChecked.value ? new Set<string>() : new Set(props.accounts.map((a) => a.id));
};

/**
 * 确认勾选（空勾选时按钮禁用，不触达此处）
 */
const onConfirm = (): void => {
  open.value = false;
  emit('confirm', props.accounts.filter((a) => draft.value.has(a.id)).map((a) => a.id));
};
</script>

<template>
  <BaseModal v-model:open="open" title="选择同步账户" max-width-class="max-w-md">
    <p class="pb-1 text-sm text-text-secondary">
      {{
        firstConfirm
          ? '已拉取账户列表，请确认参与同步的账户（后续取数只覆盖勾选账户）'
          : '勾选参与同步的账户，确认后自动重新拉取数据'
      }}
    </p>
    <div class="flex items-center justify-between pb-2 pt-1">
      <span class="text-xs text-text-tertiary">已选 {{ checkedCount }} / {{ accounts.length }} 个</span>
      <button
        v-if="accounts.length > 0"
        type="button"
        class="text-xs text-primary hover:underline"
        @click="toggleAll"
      >
        {{ allChecked ? '全部取消' : '全选' }}
      </button>
    </div>
    <!-- 空态：账户未拉到（未授权 / WAF 冷却 / 网络），引导先同步 -->
    <div
      v-if="accounts.length === 0"
      class="flex flex-col items-center gap-1 py-8 text-center"
    >
      <p class="text-sm text-text-secondary">暂未拉到账户数据</p>
      <p class="text-xs text-text-tertiary">
        请先完成「重新授权」或稍后点击「同步投资账本」补拉账户列表
      </p>
    </div>
    <div v-else class="space-y-3">
      <div v-for="group in groups" :key="group.kind">
        <p class="pb-1 text-xs text-text-tertiary">{{ group.label }}</p>
        <button
          v-for="account in group.list"
          :key="account.id"
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-flat-weak"
          :aria-pressed="draft.has(account.id)"
          @click="toggle(account)"
        >
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
            :class="draft.has(account.id) ? 'border-primary bg-primary text-white' : 'border-flat-strong text-transparent'"
          >
            <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="truncate text-text">{{ account.name }}</span>
          <span class="ml-auto shrink-0 font-mono text-xs text-text-tertiary">{{ account.id }}</span>
        </button>
      </div>
    </div>
    <template #footer>
      <BaseButton variant="ghost" @click="open = false">取消</BaseButton>
      <BaseButton variant="primary" :disabled="checkedCount === 0" @click="onConfirm">
        确认同步（{{ checkedCount }}）
      </BaseButton>
    </template>
  </BaseModal>
</template>
