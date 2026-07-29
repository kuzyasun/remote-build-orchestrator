# `@gemslibe/rbo-windows-executor-win32-x64`

Optional platform package that ships `rbo-windows-executor.exe` — the Windows Job Object
process-isolation helper used by RBO Agents on **win32-x64**.

Installed automatically as an `optionalDependency` of [`@gemslibe/rbo`](https://www.npmjs.com/package/@gemslibe/rbo).
npm/pnpm skip this package on non-Windows or non-x64 hosts.

## Contents

```text
bin/rbo-windows-executor.exe
```

## Building the binary (maintainers)

The `.exe` is **not** committed. Build it on a Windows x64 machine, then pack/publish:

```bash
# from monorepo root (Windows x64)
cargo build --release --manifest-path native/windows-executor/Cargo.toml
pnpm --filter @gemslibe/rbo-windows-executor-win32-x64 prepare-binary:require
pnpm pack:windows-executor
# equivalent: pnpm --dir packages/rbo-windows-executor-win32-x64 pack
# Do not use `pnpm --filter … pack` (pnpm 10.x: Unknown option 'recursive').
# then: npm publish --access public  (from the package dir / tarball)
```

Scripts:

| Script | Behavior |
| --- | --- |
| `prepare-binary` | Soft copy from Cargo `target/` — warns and exits 0 if missing (local layout checks) |
| `prepare-binary:require` / `prepack` | Hard require — exits 1 unless Cargo output exists **or** `bin/rbo-windows-executor.exe` is already staged |

`prepack` (and therefore `npm pack` / `npm publish`) always uses `--require`, so a tarball cannot ship without a real `.exe`.

## Runtime resolution

`@rbo/executor` (bundled into `@gemslibe/rbo`) resolves the helper via, in order:

1. `RBO_WINDOWS_EXECUTOR` env override
2. This optional package's install path (`bin/rbo-windows-executor.exe`)
3. Archive layout (`bin/` next to the CLI / package root)
4. In-repo Cargo `target/debug` and `target/release` outputs (developer builds)

`rbo doctor` warns when the helper is missing (non-Windows, wrong arch, or failed optional install).

## License

AGPL-3.0-only (same dual-licensing intent as `@gemslibe/rbo`).
