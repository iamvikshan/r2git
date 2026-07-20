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
- **Content-Addressed Archives**: Manifest entries and archive members use
  SHA-256 content hashes for reliable comparisons and restores.
- **Cloudflare R2 Backed**: High performance, zero-egress cost backups.
- **Change-Aware Push**: Skips creating a backup when the manifest is unchanged.
- **Cache-Aware Pull**: Skips rewriting files that already match locally.
- **`r2git diff`**: Compare local files against the latest remote backup without
  downloading anything.
- **Symlink Handling**: Raw symlink targets are preserved without dereferencing.
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
| **`r2git add --ignore <patterns...>`**    | Add glob patterns excluded while expanding tracked directories.                   |
| **`r2git rm [paths...]`**                 | Untrack files or directories.                                                     |
| **`r2git push`**                          | Hash files, diff against remote, upload only changed objects + manifest.          |
| **`r2git pull`**                          | Download and restore files — skips files already matching locally.                |
| **`r2git diff`**                          | Compare local file hashes against latest remote backup.                           |
| **`r2git log`**                           | Show history of remote backups (manifests) with entry counts.                     |
| **`r2git clone <org/repo>`**              | Pull down the latest backup and initialize a new project workspace.               |
| **`r2git cleanup`**                       | Find orphaned archives; use `--yes` to delete eligible objects.                   |
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
    ],
    "ignores": ["{cwd}/cache/**", "**/*.tmp"]
  }
}
```

---

## How It Works

### Content-Addressed Archive Store

r2git uses a git-like storage model:

1. **Each file and symlink target is SHA-256 hashed** for change detection
2. **Manifests** map configured file paths to hashes and metadata:
   `projects/org/repo/manifests/2026-07-18T07-58Z.json`
3. **Archives** contain hash-addressed entries such as `entries/a38f2c...d4`,
   allowing multiple configured paths with identical content to share one
   archive member
4. **Push** skips uploading when the local and latest remote manifests match;
   otherwise it streams a new compressed archive to R2
5. **Pull** streams the selected archive to extraction, then overwrites only
   files whose local hashes are missing or differ
6. **Symlinks** store their raw target bytes and are recreated during restore

### R2 Storage Layout

```
projects/org/repo/
├── manifests/
│   ├── 2026-07-18T07-58Z.json    ← full snapshot manifest
│   ├── 2026-07-18T08-30Z.json
│   └── ...
└── archives/
    ├── 2026-07-18T07-58Z-a1b2c3.tar.gz
    ├── 2026-07-18T08-30Z-d4e5f6.tar.gz
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
    "paths": ["{cwd}/.env"],
    "ignores": []
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

### Cleanup

- Dry-run by default; pass `-y, --yes` to delete eligible orphaned archives
- `--min-age <hours>`: Minimum orphan age before deletion (default: 24)
- `--prefix <p>`: Override backup prefix

### Add

- `r2git add --ignore <patterns...>`: Add one or more glob patterns;
  comma-separated patterns are also accepted

---

## License

MIT
