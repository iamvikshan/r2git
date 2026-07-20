import * as p from "@clack/prompts"

const optionNames = new Set([
  "--help",
  "-h",
  "--verbose",
  "-v",
  "--quiet",
  "-q",
  "--yes",
  "-y",
  "--dry-run",
  "-n",
  "--interactive",
  "-i",
  "--keep",
  "--prefix",
  "--backup",
  "--min-age",
  "--ignore",
  "--doppler",
  "--token",
  "--config",
  "-c",
  "--project",
  "-p",
  "--json",
])

export function readOption(args: string[], name: string): string | undefined {
  const inlinePrefix = `${name}=`
  const matches = args.filter(
    argument => argument === name || argument.startsWith(inlinePrefix),
  )
  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    p.cancel(`Error: ${name} may only be specified once`)
    process.exit(1)
  }

  const match = matches[0]
  if (!match) return undefined
  if (match.startsWith(inlinePrefix)) {
    const value = match.slice(inlinePrefix.length)
    if (!value) {
      p.cancel(`Error: ${name} requires a value`)
      process.exit(1)
    }
    return value
  }

  const index = args.indexOf(name)
  const value = args[index + 1]
  if (
    !value ||
    optionNames.has(value) ||
    [...optionNames].some(option => value.startsWith(`${option}=`))
  ) {
    p.cancel(`Error: ${name} requires a value`)
    process.exit(1)
  }
  return value
}
