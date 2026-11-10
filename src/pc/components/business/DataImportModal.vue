<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BaseButton from '../ui/BaseButton.vue';
import BaseModal from '../ui/BaseModal.vue';
import BaseConfirmModal from '../ui/BaseConfirmModal.vue';
import BaseTabs from '../ui/BaseTabs.vue';
import {
  importDataPort,
  isDataPortAvailable,
  parseImportJson,
  pickAndParseImportFile,
  summarizeImportFile,
} from '../../../common/api/data-port.api.ts';
import { DATA_PORT_MANIFEST } from '../../../common/constants/data-port.constants.ts';
import { formatBytes } from '../../../common/utils/format-bytes';
import type { DataPortFile } from '../../../common/types/data-port.types.ts';

/**
 * 数据导入弹窗（设置页「数据迁移」卡片的「导入」按钮触发）
 *
 * 双通道：选导出文件 / 粘贴 JSON 文本（PC「复制 JSON 片段」的原文），解析后共用同一套
 * 预览勾选 → 二级确认 → 覆盖写入流程。导入前自动备份涉及的 SQLite 库（appDataDir/backups），
 * 完成后整页 reload 重新水合。浏览器端无 SQLite，仅设置类（localStorage）数据可导入。
 */

const open = defineModel<boolean>('open', { required: true });

/** 桌面端才有 SQLite 数据源；浏览器端文件选择与 SQLite 类别不可用，粘贴通道仍可恢复设置类数据 */
const available = isDataPortAvailable();

/** 导入通道：file 选文件 / paste 粘贴 JSON */
const importMode = ref<'file' | 'paste'>('file');

/** BaseTabs 桥接：通道字面量 ↔ 字符串 value */
const importModeModel = computed<string>({
  get: () => importMode.value,
  set: (value) => {
    importMode.value = value === 'paste' ? 'paste' : 'file';
  },
});

/** 导入通道选项 */
const IMPORT_MODE_OPTIONS = [
  { label: '选择文件', value: 'file' },
  { label: '粘贴 JSON', value: 'paste' },
] as const;

/** 解析后的导出文件（null = 尚未选择 / 解析） */
const file = ref<DataPortFile | null>(null);

/** 粘贴通道的 JSON 原文 */
const pasteText = ref('');

/** 文件里实际包含的类别计数（类别 id → 计数表） */
const fileCounts = ref<Record<string, Record<string, number>>>({});

/** 选中文件后解析 / 预览中 */
const parsing = ref(false);

/** 导入执行中 */
const importing = ref(false);

/** 二级确认弹窗 */
const confirmOpen = ref(false);

/** 失败提示 */
const errorText = ref('');

/** 文件里存在但当前版本不识别、将被跳过的类别数 */
const skippedCount = ref(0);

/** 可勾选类别（manifest 顺序 ∩ 文件包含；浏览器端无 SQLite，过滤掉 sqlite 类别） */
const rows = computed(() =>
  DATA_PORT_MANIFEST.filter(
    (c) => (available || c.storage !== 'sqlite') && fileCounts.value[c.id] !== undefined,
  ).map((category) => {
    const counts = fileCounts.value[category.id] ?? {};
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return { category, total, empty: total === 0 };
  }),
);

/** 勾选草稿（类别 id 列表） */
const checkedIds = ref<string[]>([]);

/** 是否可执行导入 */
const canImport = computed(() => file.value !== null && checkedIds.value.length > 0);

// 打开时重置全部状态；关闭时同样清空，避免下次打开闪旧数据
watch(open, (isOpen) => {
  if (!isOpen) return;
  importMode.value = 'file';
  pasteText.value = '';
  file.value = null;
  fileCounts.value = {};
  checkedIds.value = [];
  errorText.value = '';
  skippedCount.value = 0;
  confirmOpen.value = false;
});

/**
 * 采纳解析成功的导出文件：登记文件、预览计数并播种默认勾选（选文件 / 粘贴共用）
 * @param parsed 解析后的导出文件
 */
const adoptParsedFile = (parsed: DataPortFile): void => {
  file.value = parsed;
  fileCounts.value = summarizeImportFile(parsed);
  checkedIds.value = rows.value
    .filter((row) => row.category.defaultEnabled)
    .map((row) => row.category.id);
  skippedCount.value = parsed.categories.filter(
    (c) => !DATA_PORT_MANIFEST.some((m) => m.id === c.id),
  ).length;
};

/** 选择并解析导出文件 */
const onSelectFile = async (): Promise<void> => {
  errorText.value = '';
  file.value = null;
  fileCounts.value = {};
  parsing.value = true;
  try {
    const parsed = await pickAndParseImportFile();
    if (parsed === null) return;
    adoptParsedFile(parsed);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
  } finally {
    parsing.value = false;
  }
};

/** 解析粘贴的 JSON 文本：与选文件共用同一套校验与采纳流程 */
const onParsePaste = (): void => {
  errorText.value = '';
  file.value = null;
  fileCounts.value = {};
  const text = pasteText.value.trim();
  if (text.length === 0) {
    errorText.value = '请先粘贴 JSON 内容';
    return;
  }
  try {
    adoptParsedFile(parseImportJson(text));
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
  }
};

/** 全选（仅本弹窗草稿） */
const onSelectAll = (): void => {
  checkedIds.value = rows.value.map((r) => r.category.id);
};

/** 全不选 */
const onSelectNone = (): void => {
  checkedIds.value = [];
};

/** 点「导入」→ 先开二级确认（真正写入在确认回调） */
const onRequestImport = (): void => {
  errorText.value = '';
  confirmOpen.value = true;
};

/**
 * 提取异常文案
 * @param error 未知异常
 * @returns 可展示文案
 */
const toErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 二级确认通过：执行覆盖写入，完成后整页 reload 重新水合 */
const onConfirmImport = async (): Promise<void> => {
  if (file.value === null) return;
  importing.value = true;
  try {
    await importDataPort(file.value, checkedIds.value);
    errorText.value = '';
    // 不做内存热同步（方案 §8）：整页重载让所有 store / 插件从新数据重新水合
    window.setTimeout(() => window.location.reload(), 600);
  } catch (error) {
    errorText.value = `导入失败：${toErrorText(error)}`;
    importing.value = false;
  }
};

/** 展示的导出时间（本地时区短格式） */
const exportedAtText = computed(() => {
  if (file.value === null) return '';
  const date = new Date(file.value.exportedAt);
  return Number.isNaN(date.getTime()) ? file.value.exportedAt : date.toLocaleString();
});

/** 文件体积估算（JSON 字符串按 UTF-16 计，仅展示量级） */
const fileSizeText = computed(() => {
  if (file.value === null) return '';
  return formatBytes(JSON.stringify(file.value).length);
});
</script>

<template>
  <BaseModal
    v-model:open="open"
    title="导入数据"
    max-width-class="max-w-2xl"
  >
    <!-- 通道切换：选文件（桌面端）/ 粘贴 JSON（全端） -->
    <BaseTabs
      v-model="importModeModel"
      :options="IMPORT_MODE_OPTIONS"
      aria-label="导入通道"
      data-track="DATA_IMPORT_MODE_CHANGE"
    />

    <!-- 通道一：选择文件（依赖 Tauri 文件对话框，仅桌面端） -->
    <div
      v-if="importMode === 'file'"
      class="mt-3 flex items-center justify-between gap-4"
    >
      <div class="min-w-0">
        <p class="text-sm text-text">选择导出文件</p>
        <p class="mt-0.5 text-xs text-text-tertiary">
          由本应用「数据导出」生成的 JSON 文件
        </p>
      </div>
      <BaseButton
        variant="ghost"
        data-track="DATA_IMPORT_OPEN"
        :disabled="!available || parsing || importing"
        @click="onSelectFile"
      >
        {{ parsing ? '解析中…' : file ? '重新选择' : '选择文件' }}
      </BaseButton>
    </div>

    <!-- 通道二：粘贴 JSON 文本（PC「复制 JSON 片段」的原文；浏览器端也可恢复设置类数据） -->
    <template v-else>
      <p class="mt-3 text-xs text-text-tertiary">
        粘贴「导出数据 → 复制 JSON 片段」的内容或导出文件全文
        <template v-if="!available">
          ；浏览器端无本地数据库，仅设置类（localStorage）数据可导入
        </template>
      </p>
      <textarea
        v-model="pasteText"
        rows="6"
        placeholder="粘贴 JSON 片段或导出文件全文"
        class="mt-2 w-full resize-y rounded-lg border border-flat-weak bg-transparent px-3 py-2 font-mono text-xs text-text outline-none focus:border-primary"
        aria-label="粘贴 JSON 内容"
      />
      <div class="mt-2 flex justify-end">
        <BaseButton
          variant="ghost"
          data-track="DATA_IMPORT_PASTE_PARSE"
          :disabled="importing"
          @click="onParsePaste"
        >
          解析并预览
        </BaseButton>
      </div>
    </template>

    <!-- 第二步：文件预览 + 勾选恢复类别 -->
    <template v-if="file">
      <div class="mt-4 rounded-lg bg-flat-weak px-3 py-2 text-xs text-text-tertiary">
        <p>
          来自 v{{ file.appVersion }} · 导出于 {{ exportedAtText }} · 约 {{ fileSizeText }}
        </p>
        <p
          v-if="skippedCount > 0"
          class="mt-1 text-up"
        >
          文件含 {{ skippedCount }} 类当前版本无法识别的数据，导入时将跳过
        </p>
      </div>
      <p class="mt-4 mb-2 text-xs text-text-tertiary">
        勾选要恢复的数据（仅列出文件中实际包含的类别）
      </p>
      <!-- 双列网格（与导出弹窗同款，2026-10-27 王总指定） -->
      <div class="grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2">
        <label
          v-for="row in rows"
          :key="row.category.id"
          class="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-flat-weak"
        >
          <input
            v-model="checkedIds"
            type="checkbox"
            :value="row.category.id"
            class="accent-primary mt-0.5"
            :aria-label="`导入${row.category.label}`"
          />
          <span class="min-w-0">
            <span class="flex items-baseline gap-2">
              <span class="text-sm text-text">{{ row.category.label }}</span>
              <span class="shrink-0 text-xs text-text-tertiary tabular-nums">
                <template v-if="row.category.storage === 'sqlite'">{{ row.total }} 条</template>
                <template v-else>{{ row.empty ? '空' : formatBytes(row.total) }}</template>
              </span>
            </span>
            <span
              v-if="row.category.tip"
              class="mt-0.5 block text-xs leading-4 text-text-tertiary"
            >
              {{ row.category.tip }}
            </span>
          </span>
        </label>
      </div>
    </template>

    <p
      v-if="errorText"
      class="mt-3 text-xs text-up"
    >
      {{ errorText }}
    </p>

    <template #footer>
      <div class="flex flex-1 items-center gap-2">
        <BaseButton
          variant="ghost"
          :disabled="!file || parsing || importing"
          @click="onSelectAll"
        >
          全选
        </BaseButton>
        <BaseButton
          variant="ghost"
          :disabled="!file || parsing || importing"
          @click="onSelectNone"
        >
          全不选
        </BaseButton>
      </div>
      <BaseButton
        variant="primary"
        data-track="DATA_IMPORT_CONFIRM"
        :disabled="!canImport || parsing || importing"
        @click="onRequestImport"
      >
        {{ importing ? '导入中…' : '导入' }}
      </BaseButton>
    </template>
  </BaseModal>

  <!-- 二级确认：覆盖提示（危险操作，红色确认按钮） -->
  <BaseConfirmModal
    v-model:open="confirmOpen"
    title="确认导入"
    ok-text="确认覆盖"
    cancel-text="取消"
    ok-variant="danger"
    @ok="onConfirmImport"
  >
    <p class="text-sm text-text">
      将用导出文件中的数据<strong>覆盖</strong>当前电脑勾选的类别（未勾选的不受影响）。
    </p>
    <p class="mt-2 text-xs text-text-tertiary">
      导入前会自动备份涉及的本地数据库（保留最近 3 份）；导入完成后应用会自动刷新。
    </p>
  </BaseConfirmModal>
</template>
