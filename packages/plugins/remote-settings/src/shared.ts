export const CHANNEL = '/remote-settings'
export const OPEN_WORKSPACE_ENDPOINT = 'open-workspace-directory'

export interface OpenWorkspacePayload {
  readonly path: string
}

export interface OpenWorkspaceValue {
  readonly opened: true
}
