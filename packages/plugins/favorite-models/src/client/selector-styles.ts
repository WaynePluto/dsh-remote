/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */

export const SELECTOR_STYLE_MARKER = 'data-dsh-plugin-favorite-models-selector'

export const selectorClasses = {
  root: 'dshx-favorite-models-selector',
  trigger: 'dshx-favorite-models-selector__trigger',
  triggerLabel: 'dshx-favorite-models-selector__trigger-label',
  triggerEffort: 'dshx-favorite-models-selector__trigger-effort',
  chevron: 'dshx-favorite-models-selector__chevron',
  menu: 'dshx-favorite-models-selector__menu',
  cell: 'dshx-favorite-models-selector__cell',
  cellLabel: 'dshx-favorite-models-selector__cell-label',
  cellValue: 'dshx-favorite-models-selector__cell-value',
  cellChevron: 'dshx-favorite-models-selector__cell-chevron',
  status: 'dshx-favorite-models-selector__status',
  error: 'dshx-favorite-models-selector__error',
  warning: 'dshx-favorite-models-selector__warning',
  retry: 'dshx-favorite-models-selector__retry',
  groups: 'dshx-favorite-models-selector__groups',
  group: 'dshx-favorite-models-selector__group',
  groupTitle: 'dshx-favorite-models-selector__group-title',
  option: 'dshx-favorite-models-selector__option',
  optionCopy: 'dshx-favorite-models-selector__option-copy',
  modelName: 'dshx-favorite-models-selector__model-name',
  check: 'dshx-favorite-models-selector__check',
  empty: 'dshx-favorite-models-selector__empty',
} as const

const c = selectorClasses

/** 原生 selector CSS 值，限定在本插件类名前缀下。 */
export const selectorStyles = `
.${c.root} {
  position: relative;
  min-width: 0;
}

.${c.trigger} {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 220px;
  max-width: min(360px, 45cqw);
  max-width: min(360px, 45cqw, calc(100vw - 32px));
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: 24px;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
}

.${c.trigger}:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.${c.trigger}:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}

.${c.trigger}:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}

.${c.triggerLabel} {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.${c.triggerEffort} {
  /* 推理等级说明会在模型名或 chevron 之前让出宽度。 */
  flex-shrink: 1000;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption);
}

.${c.chevron} {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption);
  transition: transform 120ms ease;
}

.${c.root}[data-open] .${c.chevron} {
  transform: rotate(180deg);
}

.${c.menu} {
  /** 将原生 selector CSS 限定在本插件的 class 前缀下。 */
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  width: max-content;
  min-width: min(240px, calc(100vw - 32px));
  max-width: min(420px, calc(100vw - 32px));
  max-height: min(360px, calc(100vh - 96px));
  overflow: hidden;
  padding: 4px;
  border: 0;
  border-radius: 20px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}

.${c.status},
.${c.empty} {
  padding: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}

.${c.error},
.${c.warning} {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  padding: 7px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}

.${c.warning} {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-state-warn-label);
}

.${c.retry} {
  flex: 0 0 auto;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.${c.groups} {
  min-height: 0;
  overflow-y: auto;
}

.${c.group} + .${c.group} {
  margin-top: 4px;
}

.${c.groupTitle} {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 5px 8px 3px;
  background: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}

.${c.option} {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 100%;
  min-height: 38px;
  padding: 6px 8px;
  border: none;
  border-radius: 10px;
  outline: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.${c.option}:hover:not(:disabled),
.${c.option}:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}

.${c.option}:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}

.${c.optionCopy} {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.${c.modelName} {
  overflow: hidden;
  color: inherit;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.${c.check} {
  display: grid;
  place-items: center;
  flex: 0 0 18px;
  color: var(--dsw-alias-label-primary);
}

.${c.cell} {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 100%;
  height: 40px;
  padding: 0 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
  text-align: left;
}

.${c.cell}:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.${c.cellLabel} {
  flex: 0 0 auto;
  white-space: nowrap;
}

.${c.cellValue} {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
}

.${c.cellChevron} {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
}
`.trim()
