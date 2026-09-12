import { describe, expect, it } from 'vitest'
import {
  neededPolicyRepairs,
  YOLO_APPROVAL_POLICY,
  YOLO_SANDBOX_MODE,
} from '../src/policy.js'

describe('neededPolicyRepairs', () => {
  it('repairs absent and confined values', () => {
    expect(neededPolicyRepairs({ sandbox: undefined, approval: undefined })).toEqual({ sandbox: true, approval: true })
    expect(neededPolicyRepairs({ sandbox: 'workspace-write', approval: 'never' })).toEqual({ sandbox: true, approval: true })
  })

  it('does not append duplicate target events', () => {
    expect(neededPolicyRepairs({ sandbox: YOLO_SANDBOX_MODE, approval: YOLO_APPROVAL_POLICY }))
      .toEqual({ sandbox: false, approval: false })
  })

  it('treats unknown future values as drift instead of silently accepting them', () => {
    expect(neededPolicyRepairs({ sandbox: 'future-mode', approval: 'future-policy' }))
      .toEqual({ sandbox: true, approval: true })
  })
})
