import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Specs that log in hash passwords with real scrypt at OWASP strength
    // (N=2^16, r=8, p=2): roughly a second per hash or verify on GitHub's
    // windows-latest runners, worse while spec files compete for two cores.
    // A single spec that stages several logins, password changes, or explicit
    // verifyPassword assertions easily runs past vitest's 5s default there,
    // so raise the ceiling for the whole package instead of sprinkling
    // per-test timeouts.
    testTimeout: 20_000,
    // Audit events fall back to a process-wide pino sink when the caller injects
    // no logger, so without this every spec that logs in would spray JSON lines
    // over the test output. Specs that assert on log output pass their own
    // logger and are unaffected.
    env: { LOG_LEVEL: 'silent' },
  },
})