<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { pluginKernel } from '../../../common/plugin/index';
import { usePluginUpdate } from '../../../common/composables/use-plugin-update';
import { useNotificationsStore } from '../../../common/stores/notifications';
import { NOTIFY_TONE } from '../../../common/constants/notify.constants.ts';
import type { NotifyTone } from '../../../common/types/notify.types.ts';
import {
  PLUGIN_UPDATE_BADGE_BUILTIN_BODY,
  PLUGIN_UPDATE_BADGE_LATEST_BODY,
  PLUGIN_UPDATE_BADGE_NOT_INDEXED_BODY,
  PLUGIN_UPDATE_BADGE_RESULT_TITLE,
  PLUGIN_UPDATE_BADGE_TOOLTIP,
  PLUGIN_UPDATE_NOTICE_SOURCE,
} from '../../../common/constants/plugin-update.constants.ts';
import type { PluginRuntimeInfo } from '../../../common/types/plugin.types.ts';

/**
 * 插件页页头版本角标（2026-11-10 王总指定）
 *
 * 当前路由归属插件（菜单贡献的独立页 / 路由贡献的隐藏页）时，在页头标题右侧
 * 显示该插件版本号；点击触发一次官方清单检查更新，有新版**直接自动更新**
 * （下载 → 校验 → 走 use-plugin-update 既有安装链，成败浮窗由链路内发出），
 * 无新版按「已是最新 / 未收录 / 内置插件」分派浮窗说明。
 * 宿主自带页面匹配不到归属插件，本组件不渲染；插件升级后内核 revision 变化，
 * 角标版本号自动跟随新版本。
 */

/** 角标交互阶段（防重入；结果浮窗由链路发，发完即回 idle） */
type BadgePhase = 'idle' | 'checking' | 'updating';

const route = useRoute();
const notifications = useNotificationsStore();
const update = usePluginUpdate();

/** 角标交互阶段 */
const phase = ref<BadgePhase>('idle');

/** 当前路由归属插件的运行时信息（宿主页 = null，不渲染角标） */
const ownerPlugin = computed<PluginRuntimeInfo | null>(() => {
  // revision 纳入依赖：插件挂载 / 卸载 / 升级后归属与版本号即时跟随
  void pluginKernel.revision.value;
  const path = route.path;
  const hit =
    pluginKernel.contributions.menu.items.find(
      (item) => path === item.path || path.startsWith(`${item.path}/`),
    ) ??
    pluginKernel.contributions.routes.routes.find(
      (item) => item.path === path || path.startsWith(`${item.path}/`),
    );
  return hit ? pluginKernel.get(hit.pluginId) : null;
});

/** 角标文案（检查 / 更新中换字，其余显示版本号） */
const badgeText = computed<string>(() => {
  if (phase.value === 'checking') return '检查中…';
  if (phase.value === 'updating') return '更新中…';
  const version = ownerPlugin.value?.version ?? '';
  return version === '' ? '' : `v${version}`;
});

/** 角标 tooltip（随阶段换） */
const badgeTooltip = computed<string>(() => {
  if (phase.value === 'checking') return '正在检查更新…';
  if (phase.value === 'updating') return '正在下载并安装更新…';
  return PLUGIN_UPDATE_BADGE_TOOLTIP;
});

/**
 * 弹一条角标结果浮窗（宿主组件直接用通知 store，不必走 app:notify 服务）
 * @param name 插件展示名
 * @param body 正文
 * @param tone 语气（失败用 up，说明用 flat / primary）
 */
const notifyResult = (name: string, body: string, tone: NotifyTone): void => {
  notifications.push({
    title: PLUGIN_UPDATE_BADGE_RESULT_TITLE(name),
    body,
    tone,
    source: PLUGIN_UPDATE_NOTICE_SOURCE,
  });
};

/**
 * 点击角标：检查更新，有新版自动安装（无确认弹窗）
 *
 * 候选只覆盖「已装且远端更新」；清单命中但无新版本 = 已是最新，
 * 清单未收录（第三方源插件）= 不支持在线检查，内置插件 = 随应用发版。
 */
const onClick = async (): Promise<void> => {
  const owner = ownerPlugin.value;
  if (!owner || phase.value !== 'idle') return;
  if (owner.builtin) {
    notifyResult(owner.name, PLUGIN_UPDATE_BADGE_BUILTIN_BODY, NOTIFY_TONE.FLAT);
    return;
  }
  phase.value = 'checking';
  try {
    await update.check({ force: true });
    if (update.status.value === 'fail') {
      notifyResult(owner.name, update.error.value, NOTIFY_TONE.UP);
      return;
    }
    if (update.candidateOf(owner.id)) {
      phase.value = 'updating';
      await update.applyUpdate(owner.id);
      return;
    }
    if (update.indexedVersionOf(owner.id) === '') {
      notifyResult(owner.name, PLUGIN_UPDATE_BADGE_NOT_INDEXED_BODY, NOTIFY_TONE.FLAT);
      return;
    }
    notifyResult(owner.name, PLUGIN_UPDATE_BADGE_LATEST_BODY(owner.version), NOTIFY_TONE.PRIMARY);
  } finally {
    phase.value = 'idle';
  }
};
</script>

<template>
  <button
    v-if="ownerPlugin && badgeText"
    type="button"
    class="pressable shrink-0 rounded-full border border-flat-weak px-1.5 py-px font-mono text-[11px] leading-4 text-text-tertiary transition-colors hover:border-primary hover:text-primary"
    :title="badgeTooltip"
    :aria-label="`${ownerPlugin.name} ${badgeText}，${badgeTooltip}`"
    data-track="PLUGIN_PAGE_VERSION_CHECK"
    @click="void onClick()"
  >
    {{ badgeText }}
  </button>
</template>
