<script setup lang="ts">
import MenuIcon from '@/pc/components/ui/MenuIcon.vue';

/**
 * 输入框斜杠命令弹层（/ 唤起，Claude Code 式补全）
 *
 * 纯展示组件：两阶段（命令候补 → 选项列表）统一渲染成行数组，勾选态、
 * 键盘高亮、选中行为都由宿主（ChatPanel）驱动——命令阶段选中=进入该类别的
 * 选项列表（技能 / MCP / 子代理勾选与 + 菜单同源，模型=切换会话模型）。
 * 外点经 fixed 全屏遮罩关闭，模式与 ComposerResourceMenu 一致。
 */
export interface SlashMenuRow {
  /** 行 id（命令阶段 = 命令字面量；选项阶段 = String(资源 id)） */
  id: string;
  /** 主标题（命令字面量 / 资源名） */
  label: string;
  /** 副标题（说明文案 / 模型 id） */
  description: string;
  /** MenuIcon 图标 key */
  icon: string;
  /** 是否勾选（选项阶段的当前选中 / 当前模型） */
  checked: boolean;
  /** 行尾徽标文案（如模型行的「默认」） */
  badge?: string;
}

const props = defineProps<{
  /** 弹层标题（命令阶段为「斜杠命令」，选项阶段为类别标题） */
  heading: string;
  /** 渲染行（宿主已按查询过滤、已映射勾选态） */
  rows: SlashMenuRow[];
  /** 键盘 / 悬停高亮的行下标 */
  activeIndex: number;
  /** 无候补时的空态文案 */
  emptyText: string;
}>();

const emit = defineEmits<{
  /** 选中某行 */
  (e: 'select', id: string): void;
  /** 悬停某行（同步键盘高亮） */
  (e: 'hover', index: number): void;
  /** 请求关闭（遮罩外点） */
  (e: 'close'): void;
}>();

/**
 * 点击行（选中）
 * @param row 行数据
 */
const pick = (row: SlashMenuRow): void => {
  emit('select', row.id);
};
</script>

<template>
  <!-- 外点遮罩：全屏透明层，压在输入区上方、弹层下方 -->
  <div class="fixed inset-0 z-40" @click="emit('close')" />

  <div
    class="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-flat-weak bg-surface py-1 shadow-lg"
    role="listbox"
    :aria-label="props.heading"
  >
    <p class="px-3 pb-1 pt-1.5 text-[11px] text-text-tertiary">{{ props.heading }}</p>
    <button
      v-for="(row, index) in props.rows"
      :key="row.id"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
      :class="index === props.activeIndex ? 'bg-flat-weak' : 'hover:bg-flat-weak'"
      @click="pick(row)"
      @mouseenter="emit('hover', index)"
    >
      <MenuIcon
        name="check"
        :size="14"
        class="shrink-0"
        :class="row.checked ? 'text-primary' : 'text-transparent'"
      />
      <MenuIcon v-if="!row.checked" :name="row.icon" :size="14" class="shrink-0 text-text-tertiary" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-text">{{ row.label }}</span>
        <span v-if="row.description" class="block truncate text-[11px] text-text-tertiary">
          {{ row.description }}
        </span>
      </span>
      <span
        v-if="row.badge"
        class="shrink-0 rounded bg-flat-weak px-1.5 py-0.5 text-[10px] text-text-tertiary"
      >
        {{ row.badge }}
      </span>
    </button>
    <p v-if="props.rows.length === 0" class="px-3 py-2 text-xs text-text-tertiary">
      {{ props.emptyText }}
    </p>
  </div>
</template>
