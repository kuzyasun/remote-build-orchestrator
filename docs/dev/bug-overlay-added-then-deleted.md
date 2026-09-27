# Bug writeup: overlay capture fails for index-added files deleted in the worktree (AD)

> Status: confirmed code-path bug, untriaged. Observed during an ESP-IDF 6.1 RBO build on 2026-09-27.
> The failing snapshot attempt did not return a job ID or remote logs, so this explanation combines the reported error with the captured Git status and current source behavior.

## Summary

An RBO job failed before compilation with:

    ENOENT: no such file or directory, realpath 'C:\projects\radar\radar-a121\esp-a121\sdkconfig.defaults.esp32'

At the time, git status showed AD esp-a121/sdkconfig.defaults.esp32: the file had been added to the index, then deleted from the working tree. The intended snapshot is the final working-tree state, in which this path is absent. RBO instead planned to capture it as a file and failed when it tried to resolve the missing path.

## Expected behavior

A staged addition deleted in the working tree is absent from the final filesystem state. Because the path does not exist in the base commit either, an overlay should omit it from both the file payload and deletion list. Capture should continue and preserve the other staged and unstaged changes.

No user setting or git add is required for normal unstaged changes. The repository design says snapshots capture the actual filesystem state, including unstaged changes and staged-plus-unstaged changes to one file.

## Relevant code path

- packages/snapshot/src/git-status.ts retains the porcelain XY status, including AD.
- packages/snapshot/src/overlay.ts, computeOverlayPlan: the generic deletion branch treats AD as a deletion plus a remaining staged change, then adds the path to files. That is wrong for an added-then-deleted path because no working-tree bytes exist.
- packages/snapshot/src/capture.ts sends every planned file through metadata preflight.
- packages/snapshot/src/metadata-preflight.ts validates the path with assertRealPathContained before lstat; containment resolution calls realpath. The absent file therefore produces the reported ENOENT.

The same-file staged-plus-unstaged test covers a file that still exists, and the unstaged-only test covers a modified existing file. There is no regression case for staged addition followed by working-tree deletion (AD).

## Project-root setting

The failed invocation used project_root=...\radar-a121\esp-a121; the later successful invocation used the repository root and explicitly changed into esp-a121. RBO resolves both project roots to the same Git repository and captures the whole repository. A nested project_root changes the default job working directory to esp-a121; it does not restrict snapshot contents or fix this overlay selection.

The subsequent success does not establish that changing project_root fixed the error. With the same overlay status and capture mode, the current code predicts the same failure. The exact status and capture mode for that successful attempt were not retained, so the difference is unknown.

## Suggested fix and regression coverage

Handle AD as an absent final path in computeOverlayPlan: do not include it as a file, and do not emit a deletion against HEAD when the path was never in the base tree. Add an overlay-capture test that stages a new file, deletes it from the worktree, then asserts capture succeeds and the manifest contains neither a file entry nor a deletion for that path.

Existing unstaged-only and staged-plus-unstaged-existing-file cases should remain unchanged.
