# r2git

`r2git` is a project-agnostic, git-style CLI tool powered by **Bun** to easily
backup, sync, and restore `.gitignored` files, environment secrets, seed
databases, and local assets directly to **Cloudflare R2** storage.

Adopting the commands developers already know and love (`add`, `status`, `push`,
`pull`, `clone`, `diff`), `r2git` acts as a parallel version control system for
files too sensitive or too large to be committed to git.

---

## Features

- **Git-Style Workflows**: Manage ignored files using `add`, `rm`, `status`,
  `push`, `pull`, `log`, `diff`, and `clone`.
- **Content-Addressed Storage**: Files are stored by SHA-256 hash — automatic
  deduplication, incremental uploads, and fast comparisons.
- **Cloudflare R2 Backed**: High performance, zero-egress cost backups.
- **Incremental Push**: Only uploads files that changed since the last backup.
- **Cache-Aware Pull**: Skips downloading files that already match locally.
- **`r2git diff`**: Compare local files against the latest remote backup without
  downloading anything.
- **Symlink Handling**: Symlinks are individually tarred and stored separately.
- **VCS-Safe Layout**: Private credentials live in `~/.r2gitrc`, while
  repository-tracked paths live in `.r2gitconfig` (safe to commit to Git).
- **Interactive TUI**: Beautiful user experiences powered by `@clack/prompts`.
- **Structured Logging**: Per-path progress, verbose/quiet modes, colored
  output.
- **Rich Path Variables**: `{cwd}`, `{home}`, `{project}`, `{xdg_config}`,
  `{xdg_data}`, `{xdg_cache}`, `{tmp}`, `~`, absolute, and relative paths.
- **Git Hook Setup**: Auto-initialize git and stage configurations on setup.

---

## Installation

```bash
# Using Bun (Recommended)
bun add -g @syncron/r2git

# Using npm
npm install -g @syncron/r2git
```

---

## Command Reference

| Command                                   | Description                                                                       |
| :---------------------------------------- | :-------------------------------------------------------------------------------- |
| **`r2git init`**                          | Interactive setup for global credentials (`~/.r2gitrc`) and local project config. |
| **`r2git status`**                        | Show tracked files, hash-based diff against latest remote backup.                 |
| **`r2git add [paths...]`**                | Start tracking files or directories (supports path variables).                    |
| **`r2git rm [paths...]`**                 | Untrack files or directories.                                                     |
| **`r2git push`**                          | Hash files, diff against remote, upload only changed objects + manifest.          |
| **`r2git pull`**                          | Download and restore files — skips files already matching locally.                |
| **`r2git diff`**                          | Compare local file hashes against latest remote backup.                           |
| **`r2git log`**                           | Show history of remote backups (manifests) with entry counts.                     |
| **`r2git clone <org/repo>`**              | Pull down the latest backup and initialize a new project workspace.               |
| **`r2git auth <login\|status\|doppler>`** | Authenticate credentials.                                                         |
| **`r2git project <list\|switch>`**        | Manage multiple projects.                                                         |

---

## Path Variables

Use these in `.r2gitconfig` paths for portable, environment-agnostic configs:

| Variable       | Resolves to                          |
| :------------- | :----------------------------------- |
| `{cwd}`        | Current working directory            |
| `{home}`       | User home directory (`$HOME`)        |
| `~`            | User home directory (shorthand)      |
| `{project}`    | Project name from config             |
| `{xdg_config}` | `$XDG_CONFIG_HOME` or `~/.config`    |
| `{xdg_data}`   | `$XDG_DATA_HOME` or `~/.local/share` |
| `{xdg_cache}`  | `$XDG_CACHE_HOME` or `~/.cache`      |
| `{tmp}`        | OS temp directory                    |

Example `.r2gitconfig`:

```json
{
  "project": "my-org/my-repo",
  "backup": {
    "retention": 5,
    "paths": [
      "{cwd}/.env",
      "{cwd}/secrets.json",
      "{home}/.config/myapp/config.yaml",
      "{xdg_config}/myapp/credentials"
    ]
  }
}
```

---

## How It Works

### Content-Addressed Object Store

r2git uses a git-like storage model:

1. **Each file is SHA-256 hashed** — identical files are stored only once
2. **Objects stored by hash** in R2: `projects/org/repo/objects/a3/8f2c...d4`
3. **Manifests** map file paths to hashes:
   `projects/org/repo/manifests/2026-07-18T07-58Z.json`
4. **Push** diffs local hashes against the latest remote manifest — uploads only
   new/changed objects
5. **Pull** compares local file hashes against the manifest — downloads and
   overwrites files whose local hashes are missing or differ
6. **Symlinks** are individually tarred and stored as special objects

### R2 Storage Layout

```
projects/org/repo/
├── manifests/
│   ├── 2026-07-18T07-58Z.json    ← full snapshot manifest
│   ├── 2026-07-18T08-30Z.json
│   └── ...
└── objects/
    ├── a3/
    │   └── 8f2c...d4             ← content-addressed, deduplicated
    ├── b7/
    │   └── 1e9a...f2
    └── ...
```

---

## Configuration Layout

### 1. Local Configuration (`.r2gitconfig`)

Lives in your repository root. Lists non-secret files to track. **Safe to
commit.**

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

Lives in your user home directory. Contains Cloudflare R2 access keys. **Do not
commit.**

```json
{
  "activeProject": "my-org/my-repo",
  "projects": {},
  "r2": {
    "accountId": "your-r2-account-id",
    "accessKeyId": "your-r2-access-key-id",
    "secretAccessKey": "your-r2-secret-access-key",
    "bucket": "r2git"
  }
}
```

---

## Flags

### Global

- `-v, --verbose`: Enable debug logging
- `-q, --quiet`: Suppress non-essential output
- `-h, --help`: Show help

### Push

- `-n, --dry-run`: Preview actions without uploading
- `-y, --yes`: Skip confirmations
- `--keep <N>`: Override retention count for this push
- `--prefix <p>`: Override backup prefix

### Pull

- `-n, --dry-run`: Preview actions without downloading
- `-i, --interactive`: Select a historical backup from a menu
- `--backup <key>`: Restore from a specific manifest key

### Log

- `-v, --verbose`: Show entry counts and parent info per manifest
- `--prefix <p>`: Override backup prefix

---

## License

MIT
