import * as p from "@clack/prompts"

export function readOption(
  args: string[],
  name: string,
  optionNames: readonly string[],
): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (!value || optionNames.includes(value)) {
    p.cancel(`Error: ${name} requires a value`)
    process.exit(1)
  }
  return value
}
