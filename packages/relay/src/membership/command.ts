/**
 * hub 控制台会打印一条可直接运行的 connector 命令，其中已经包含 relay URL、机器名、
 * 注册令牌以及要信任的 authority。粘贴这一行是设置远程入口的唯一方式：其中每个值都来自
 * 入口机器，因此无需手动输入任何内容，也不会抄错内容。
 */

export interface ParsedConnectorCommand {
  readonly relayUrl?: string
  readonly slug?: string
  readonly enrollToken?: string
  readonly browserAuthority?: string
}

/** 类 shell 分词器：引号会生效，其余内容按空格拆分。 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: string | undefined
  for (const character of input) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push(current)
  // 从自动换行的终端复制粘贴时，续行符仍会保留。
  return tokens.filter(token => token !== '\\' && token !== '`')
}

const FLAGS = {
  '--relay': 'relayUrl',
  '--slug': 'slug',
  '--enroll-token': 'enrollToken',
  '--hub-authority': 'browserAuthority',
} as const satisfies Record<string, keyof ParsedConnectorCommand>

/**
 * 从粘贴的 `dsh-remote-connector …` 命令行中提取加入参数。
 *
 * 只读取描述 hub membership 的四个 flag；程序名和其他 flag 都会忽略，因此带有额外本地选项
 * （`--dsh-port`、`--device-key` 等）的命令仍能工作。这里不做校验：调用方会对所有不可信输入
 * 执行相同检查。
 * @param input - 粘贴的文本；可以为空。
 * @returns 四个 flag 携带的值；只有有值时才会存在对应字段。
 */
export function parseConnectorCommand(input: string): ParsedConnectorCommand {
  const tokens = tokenize(input)
  const found: { -readonly [K in keyof ParsedConnectorCommand]: string } = {}
  for (const [index, token] of tokens.entries()) {
    const separator = token.indexOf('=')
    const flag = separator === -1 ? token : token.slice(0, separator)
    if (!Object.hasOwn(FLAGS, flag)) continue
    const key = FLAGS[flag as keyof typeof FLAGS]
    if (separator !== -1) {
      found[key] = token.slice(separator + 1)
      continue
    }
    const value = tokens[index + 1]
    // 一个 flag 后面紧跟另一个 flag，说明它没有值；应视为缺失，
    // 而不是把下一个 flag 吞作当前 flag 的参数。
    if (value === undefined || value.startsWith('--')) continue
    found[key] = value
  }
  return found
}
