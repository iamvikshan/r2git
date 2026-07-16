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

GLOBAL FLAGS
  -h, --help                Show help for r2git or a command

PUSH/PULL FLAGS
  -y, --yes                 Skip confirmations
  -n, --dry-run             Print actions without executing
  -i, --interactive         Pick backup to pull interactively
  --keep <N>                Number of backups to keep (push only)
  --backup <key>            Specific backup key to pull (pull only)
`)
  process.exit(status)
}

type CommandRunner = (args: string[]) => Promise<void> | void

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
  log: async args => {
    await cmdLog(args)
  },
  list: async args => {
    await cmdLog(args)
  },
  clone: async args => {
    await cmdClone(args[0])
  },
  auth: async args => {
    await cmdAuth(args)
  },
  project: async args => {
    await cmdProject(args)
  },
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd || cmd === "--help" || cmd === "-h") help(0)

  const runner = commandRegistry[cmd]
  if (runner) {
    await runner(args.slice(1))
  } else {
    console.error(`Unknown command: ${cmd}`)
    help(1)
  }
}

main().catch((e: unknown) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
