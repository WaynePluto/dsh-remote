const STYLE_ID = 'dsh-plugin-files-styles'
const CSS = `
.dsh-files-native-enhancement{display:flex;flex:1 1 auto;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.dsh-files-native-enhancement>[data-files-state]{flex:1 1 auto;min-width:0;min-height:0;height:100%}
.dsh-files-native-note{flex:none;padding:5px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsh-files-directory-guide{display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;box-sizing:border-box;min-height:100%;padding:0 24px;background:var(--dsw-alias-bg-base)}
.dsh-files-directory-guide::after{content:'';flex:0 1 10%}
.dsh-files-directory-hero{display:flex;margin-bottom:16px;color:var(--dsw-static-neutral-200)}
body[data-ds-dark-theme] .dsh-files-directory-hero{color:var(--dsw-static-neutral-700)}
.dsh-files-directory-entry{display:flex;gap:14px;align-items:center;box-sizing:border-box;width:380px;max-width:100%;min-height:56px;padding:14px 20px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:24px;cursor:pointer}
.dsh-files-directory-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-files-directory-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-files-directory-icon{display:flex;flex:none;align-items:center;justify-content:center;width:26px;height:26px;color:var(--dsw-alias-label-secondary);line-height:0}
.dsh-files-directory-copy{display:flex;min-width:0;flex-direction:column;gap:3px}
.dsh-files-directory-title{overflow:hidden;font-size:15px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.dsh-files-directory-description{overflow:hidden;color:var(--dsw-alias-label-caption);font-size:13px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-marker]{position:relative}
.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-marker]::after{content:attr(data-files-git-marker);display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:16px;margin-left:auto;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;font-weight:650;line-height:1}
.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-status=modified]::after{color:var(--dsw-alias-state-warn-primary)}
.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-status=added]::after,.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-status=untracked]::after,.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-status=copied]::after{color:var(--dsw-alias-state-success-primary)}
.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-status=renamed]::after{color:var(--dsw-alias-state-business-primary)}
.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-status=deleted]::after,.dsh-files-native-enhancement [data-files-entry]>button[data-files-git-status=conflict]::after{color:var(--dsw-alias-state-error-primary)}
.dsh-files-preview-tab-title{display:inline-flex;flex:1 1 auto;align-items:center;gap:5px;min-width:0;max-width:100%;overflow:hidden;line-height:1.4;white-space:nowrap}
.dsh-files-preview-tab-title svg{display:block;flex:none}
.dsh-files-preview-tab-title-temporary{font-style:italic}
.dsh-files-tab-menu-item{display:block;width:100%;padding:5px 8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.4;text-align:left;background:transparent;border:0;border-radius:4px;cursor:pointer}
.dsh-files-tab-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-files-tab-menu-item:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dsh-files-image-toolbar{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:4px;min-height:32px;padding:4px 8px;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:10000;pointer-events:auto}
.dsh-files-image-tool{display:flex;align-items:center;justify-content:center;min-width:28px;height:24px;padding:0 6px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;border:0;border-radius:4px;background:transparent;cursor:pointer}
.dsh-files-image-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-files-image-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-files-image-percent{min-width:42px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:24px;text-align:center;font-variant-numeric:tabular-nums}
`

export function installStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  return () => { style.remove() }
}
