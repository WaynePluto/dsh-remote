export const en = {
  gitUnavailable: 'Git status unavailable',
  gitTruncated: 'Git status was truncated.',
  copyPath: 'Copy path',
  copyRelativePath: 'Copy relative path',
  copyFailed: 'Could not copy the path.',
  statusModified: 'Modified',
  statusAdded: 'Added',
  statusDeleted: 'Deleted',
  statusRenamed: 'Renamed',
  statusUntracked: 'Untracked',
  statusConflict: 'Conflict',
  closeOthers: 'Close others',
  closeAll: 'Close all',
  imageZoomToolbar: 'Image zoom controls',
  imageZoomOut: 'Zoom out',
  imageZoomIn: 'Zoom in',
  imageZoomActual: 'Actual size',
  imageZoomFit: 'Fit image to window',
  imageZoomFitShort: 'Fit',
  imageZoomPercent: '{value}%',
} as const

export type FilesKey = keyof typeof en
export type Translate = (key: FilesKey, params?: Record<string, string | number>) => string

export const zh: Record<FilesKey, string> = {
  gitUnavailable: 'Git 状态不可用',
  gitTruncated: 'Git 状态条目已截断。',
  copyPath: '复制路径',
  copyRelativePath: '复制相对路径',
  copyFailed: '复制路径失败，请重试。',
  statusModified: '已修改',
  statusAdded: '已新增',
  statusDeleted: '已删除',
  statusRenamed: '已重命名',
  statusUntracked: '未跟踪',
  statusConflict: '有冲突',
  closeOthers: '关闭其他',
  closeAll: '关闭全部',
  imageZoomToolbar: '图片缩放控制',
  imageZoomOut: '缩小图片',
  imageZoomIn: '放大图片',
  imageZoomActual: '实际大小',
  imageZoomFit: '适应窗口',
  imageZoomFitShort: '适应',
  imageZoomPercent: '{value}%',
}

export const NS = 'dsh-plugin-files'
