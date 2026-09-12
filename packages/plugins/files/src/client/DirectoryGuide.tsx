import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './locales.js'

type GuideProps = PropsRuntime<'sidebar.right.tab.guide'>

function CompassGlyph(): ReactNode {
  return (
    <svg width="56" height="56" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M 10.9 5.1 L 9.1 9.1 L 5.1 10.9 L 6.9 6.9 Z" fill="currentColor" />
    </svg>
  )
}

/** A one-entry start page kept visible when dsh would otherwise auto-seed files. */
export function createDirectoryGuide(t: Translate): (props: GuideProps) => ReactNode {
  return function DirectoryGuide({ useTabInfo }: GuideProps): ReactNode {
    const { tab } = useTabInfo() as SidebarRightTabInfo
    return (
      <div className="dsh-files-directory-guide" data-files-directory-guide data-sidebar-right-guide>
        <span className="dsh-files-directory-hero"><CompassGlyph /></span>
        <button
          type="button"
          className="dsh-files-directory-entry"
          data-files-directory-entry
          data-sidebar-right-guide-entry="files"
          onClick={() => { tab.actions.openTab('files', { replaceTab: true }) }}
        >
          <span className="dsh-files-directory-icon"><FileTypeIcon kind="folder" size={22} /></span>
          <span className="dsh-files-directory-copy">
            <span className="dsh-files-directory-title">{t('directoryGuideTitle')}</span>
            <span className="dsh-files-directory-description">{t('directoryGuideDescription')}</span>
          </span>
        </button>
      </div>
    )
  }
}
