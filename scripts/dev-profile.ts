import {
  DSH_REMOTE_PROFILE_BUNDLES,
  type ensureProfile,
} from '../packages/launcher/src/profile.js'

/** 开发栈与发行版共用最小 profile；功能插件随后按第三方依赖同步。 */
export function developmentProfileOptions(home: string): Parameters<typeof ensureProfile>[0] {
  return {
    home,
    profile: 'dsh-remote-web',
    bundles: DSH_REMOTE_PROFILE_BUNDLES,
  }
}
