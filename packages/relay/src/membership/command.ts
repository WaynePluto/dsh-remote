/**
 * The hub console prints a ready-to-run connector command with the relay URL,
 * the machine name, the enrollment token and the authority to trust already in
 * it. Pasting that single line is the only way to set a remote entry: every
 * value in it comes from the entry machine, so there is nothing left to type by
 * hand and nothing to transcribe wrong.
 */

export interface ParsedConnectorCommand {
  readonly relayUrl?: string
  readonly slug?: string
  readonly enrollToken?: string
  readonly browserAuthority?: string
}

/** Shell-ish tokenizer: quotes are honoured, everything else splits on spaces. */
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
  // Line continuations survive a copy-paste from a wrapped terminal.
  return tokens.filter(token => token !== '\\' && token !== '`')
}

const FLAGS = {
  '--relay': 'relayUrl',
  '--slug': 'slug',
  '--enroll-token': 'enrollToken',
  '--hub-authority': 'browserAuthority',
} as const satisfies Record<string, keyof ParsedConnectorCommand>

/**
 * Pull the join parameters out of a pasted `dsh-remote-connector …` command line.
 *
 * Only the four flags that describe a hub membership are read; the program name
 * and every other flag are ignored, so a command carrying extra local options
 * (`--dsh-port`, `--device-key`, …) still works. Nothing is validated here: the
 * caller runs the same checks it would run on any untrusted input.
 * @param input - the pasted text; may be empty.
 * @returns Whatever the four flags carried, each present only when it had a value.
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
    // A flag followed by another flag carries no value; treat it as absent
    // rather than swallowing the next flag as this one's argument.
    if (value === undefined || value.startsWith('--')) continue
    found[key] = value
  }
  return found
}
