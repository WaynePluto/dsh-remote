import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 使用真实 OWASP 强度 scrypt 哈希密码的测试
    // （N=2^16、r=8、p=2）：在 GitHub 的
    // windows-latest runner 上每次哈希或验证约需一秒；测试文件争用两个核心时更慢。
    // 一个测试如果包含多次登录、改密码或显式
    // verifyPassword 断言，很容易超过 vitest 在该环境中的 5 秒默认值，
    // 因此提高整个包的上限，而不是到处添加
    // 单测试超时。
    testTimeout: 20_000,
    // 调用方未注入 logger 时，审计事件会回退到进程级 pino 出口，
    // 没有此设置，每个执行登录的测试都会把 JSON 行喷到
    // 测试输出中。断言日志输出的测试会传入自己的
    // logger，不受影响。
    env: { LOG_LEVEL: 'silent' },
  },
})