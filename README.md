# r2git

`r2git` is a project-agnostic, git-style CLI tool powered by **Bun** to easily
backup, sync, and restore `.gitignored` files, environment secrets, seed
databases, and local assets directly to **Cloudflare R2** storage.

Adopting the commands developers already know and love (`add`, `status`, `push`,
`pull`, `clone`), `r2git` acts as a parallel version control system for files
too sensitive or too large to be committed to git.

---

## Features

- **Git-Style Workflows**: Manage ignored files using `add`, `rm`, `status`,
  `push`, `pull`, `log`, and `clone`.
- **Cloudflare R2 Backed**: High performance, zero-egress cost backups.
- **VCS-Safe Layout**: Private credentials live in `~/.r2gitrc`, while
  repository-tracked paths live in `.r2gitconfig` (safe to commit to Git).
- **Interactive TUI**: Beautiful user experiences powered by `@clack/prompts`
  including status spinners, multiselect lists, password masking, and connection
  testing.
- **Git Hook Setup**: Auto-initialize git and stage configurations on setup.
- **VCS Path Depth**: Organizes backup directories in R2 natively by repository
  names under a clean `[org]/[repo]/` structure.

---

## Installation

To install globally:

```bash
# Using Bun (Recommended)
bun add -g r2git

# Using npm
npm install -g r2git
```

---

## Command Reference

| Command                                   | Description                                                                                                                  |
| :---------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **`r2git init`**                          | Interactive setup for global credentials (`~/.r2gitrc`) and local project selection (`.r2gitconfig`).                        |
| **`r2git status`**                        | Compare workspace changes with the latest R2 backup, detailing modified timestamps.                                          |
| **`r2git add [paths...]`**                | Start tracking files or directories (e.g. `.env`, `supabase/seed.sql`).                                                      |
| **`r2git rm [paths...]`**                 | Untrack files or directories.                                                                                                |
| **`r2git push`**                          | Archive tracked paths and upload to R2, respecting backup retention counts.                                                  |
| **`r2git pull`**                          | Download and extract files to restore your workspace.                                                                        |
| **`r2git log`**                           | List historical backups stored on Cloudflare R2 for the project.                                                             |
| **`r2git clone <org/repo>`**              | Pull down the latest backup and initialize a new project workspace.                                                          |
| **`r2git auth <login\|status\|doppler>`** | Authenticate credentials (supports manual R2 keys, Doppler CLI oauth, or Doppler web tokens) or run connection health check. |
| **`r2git project <list\|switch>`**        | Manage multiple projects or configure active local configurations.                                                           |

---

## Configuration Layout

### 1. Local Configuration (`.r2gitconfig`)

Lives in your repository root. It lists non-secret files to track. **Safe to
commit to Git.**

```json
{
  "project": "my-org/my-repo",
  "backup": {
    "retention": 5,
    "paths": ["{cwd}/.env"]
  }
}
```

### 2. Global Configuration (`~/.r2gitrc`)

Lives securely in your user home directory. It contains Cloudflare R2 access
keys. **Do not commit this.**

```json
{
  "activeProject": "my-org/my-repo",
  "projects": {},
  "r2": {
    "accountId": "your-r2-account-id",
    "accessKeyId": "your-access-key-id",
    "secretAccessKey": "your-secret-access-key",
    "bucket": "my-backups"
  }
}
```

---

## Flags

- `-y, --yes`: Skip interactive confirmations.
- `-n, --dry-run`: View actions without archiving or uploading.
- `-i, --interactive` (pull only): Select a historical backup from a menu
  instead of default latest.
- `--keep <N>` (push only): Override the local retention count for this push.
- `--backup <key>` (pull only): Restore from a specific backup key.

---

## License

MIT
