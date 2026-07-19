# Project Conventions for AI Agents

## Type Safety

- Strict TypeScript mode must be maintained at all times.
- No `as` type casting, `// @ts-ignore`, `// @ts-expect-error`, or
  `eslint-disable` comments.
- Use proper type narrowing, generics, or declare explicit types instead.
- Avoid `any` — prefer `unknown` with proper narrowing where the type is not
  known.

## API Usage

- Prefer Bun-native APIs (`Bun.write`, `Bun.file`, `Bun.spawnSync`, etc.) where
  available.
- Use `node:fs` for filesystem operations Bun does not natively expose
  (mkdirSync, chmodSync, rmSync, cpSync, lstatSync, accessSync, readdirSync).

## Documentation Sync

- `README.md` and the inline help text in `src/main.ts` must always list the
  same commands, flags, and options.
- When adding a new command or flag, update both files.

## Code Style

- No comments in code unless they explain non-obvious behavior.
- Follow existing naming conventions and file structure.
- No emojis, just kaomoji and unix-style text formatting.
- Symlink handling uses tar archives stored as `symlink-tar` entry type.
