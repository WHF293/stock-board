<script setup lang="ts">
import { ref } from 'vue';
import BaseModal from '../../ui/BaseModal.vue';
import BaseButton from '../../ui/BaseButton.vue';

/**
 * 投资账本错误详情弹窗（浮窗通知点击「查看完整报错」入口）
 *
 * 浮窗正文空间小、摘要截断，服务端完整报错（WAF 503 JSON / MCP HTTP 401 响应体 /
 * token endpoint 错误摘要等排查关键信息）在这里全文展示，支持一键复制给排查用
 */
const props = defineProps<{
  /** 弹窗标题（同通知标题） */
  title: string;
  /** 完整报错文本（服务端保留信息原样展示） */
  detail: string;
}>();

const open = defineModel<boolean>('open', { required: true });

/** 已复制标记（按钮文案反馈） */
const copied = ref(false);

/**
 * 复制完整报错到剪贴板（1.5s 后恢复按钮文案）
 */
const copyDetail = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(props.detail);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1_500);
  } catch {
    // 剪贴板权限拒绝：静默忽略（文本仍可手动选中复制）
  }
};
</script>

<template>
  <BaseModal v-model:open="open" :title="title" max-width-class="max-w-2xl">
    <p class="pb-2 text-xs text-text-tertiary">服务端完整报错（排查用，可复制）</p>
    <pre
      class="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-flat-weak p-3 font-mono text-xs leading-5 text-text-secondary"
    >{{ detail }}</pre>
    <template #footer>
      <BaseButton variant="ghost" @click="copyDetail">{{ copied ? '已复制' : '复制报错信息' }}</BaseButton>
      <BaseButton variant="primary" @click="open = false">关闭</BaseButton>
    </template>
  </BaseModal>
</template>
