import { cmdInit } from "./commands/init"
import { cmdStatus } from "./commands/status"
import { cmdAdd } from "./commands/add"
import { cmdRm } from "./commands/rm"
import { cmdPush } from "./commands/push"
import { cmdPull } from "./commands/pull"
import { cmdLog } from "./commands/log"
import { cmdClone } from "./commands/clone"
import { cmdAuth } from "./commands/auth"
import { cmdProject } from "./commands/project"
import { cmdDiff } from "./commands/diff"
import { setLogLevel } from "./utils/log"

function help(status: number): never {
  console.log(`
r2git - Backup and restore .gitignored files/secrets in the git style

USAGE
  r2git <command> [subcommand] [flags]

CORE COMMANDS
  init                      Initialize a local .r2gitconfig configuration
  status                    Show the status of tracked files and remote backups
  add [paths...]            Add files/directories to the tracked list
  rm [paths...]             Remove files/directories from the tracked list (aliases: remove)
  push                      Upload local tracked files to remote R2 backup
  pull                      Download and restore tracked files from R2 backup
  log                       Show history of remote R2 backups
  clone [project-name]      Clone and restore a project's backups from R2

ADDITIONAL COMMANDS
  auth <login|status|doppler> Manage credentials (supports manual R2 keys, Doppler CLI oauth, or Doppler web tokens)
  project <list|switch>     Manage active projects and settings
  diff                      Compare local files against latest remote backup

GLOBAL FLAGS
  -h, --help                Show help for r2git or a command
  -v, --verbose             Enable verbose/debug logging
  -q, --quiet               Suppress non-essential output

PUSH/PULL FLAGS
  -y, --yes                 Skip confirmations
  -n, --dry-run             Print actions without executing
  -i, --interactive         Pick backup to pull interactively
  --keep <N>                Number of backups to keep (push only)
  --backup <key>            Specific backup key to pull (pull only)
`)
  process.exit(status)
}

type CommandRunner = (
  args: string[],
  verboseFlag?: boolean,
) => Promise<void> | void

function verboseArgs(
  cmd: (args: string[]) => Promise<void>,
): (args: string[], verboseFlag?: boolean) => Promise<void> {
  return async (args, verboseFlag) => {
    await cmd(verboseFlag ? [...args, "--verbose"] : args)
  }
}

const commandRegistry: Record<string, CommandRunner> = {
  init: async () => {
    await cmdInit()
  },
  status: async () => {
    await cmdStatus()
  },
  add: async args => {
    await cmdAdd(args)
  },
  rm: async args => {
    await cmdRm(args)
  },
  remove: async args => {
    await cmdRm(args)
  },
  push: async args => {
    await cmdPush(args)
  },
  backup: async args => {
    await cmdPush(args)
  },
  pull: async args => {
    await cmdPull(args)
  },
  restore: async args => {
    await cmdPull(args)
  },
  log: verboseArgs(cmdLog),
  history: verboseArgs(cmdLog),
  list: verboseArgs(cmdLog),
  clone: async args => {
    await cmdClone(args[0])
  },
  auth: async args => {
    await cmdAuth(args)
  },
  project: async args => {
    await cmdProject(args)
  },
  diff: async () => {
    await cmdDiff()
  },
  compare: async () => {
    await cmdDiff()
  },
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Handle global flags before command dispatch
  const verboseFlag = args.includes("--verbose") || args.includes("-v")
  const quietFlag = args.includes("--quiet") || args.includes("-q")

  if (verboseFlag) {
    setLogLevel("debug")
  }
  if (quietFlag) {
    setLogLevel("error")
  }

  // Strip global flags from args passed to commands
  const filteredArgs = args.filter(
    a => a !== "--verbose" && a !== "-v" && a !== "--quiet" && a !== "-q",
  )

  const cmd = filteredArgs[0]

  if (!cmd || cmd === "--help" || cmd === "-h") help(0)

  const runner = commandRegistry[cmd]
  if (runner) {
    await runner(filteredArgs.slice(1), verboseFlag)
  } else {
    console.error(`Unknown command: ${cmd}`)
    help(1)
  }
}

main().catch((e: unknown) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
