import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Audit events fall back to a process-wide pino sink when the caller injects
    // no logger, so without this every spec that logs in would spray JSON lines
    // over the test output. Specs that assert on log output pass their own
    // logger and are unaffected.
    env: { LOG_LEVEL: 'silent' },
  },
})