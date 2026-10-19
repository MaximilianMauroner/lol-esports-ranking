# Saved branch and tag histories

This tag preserves all 251 remote branch names and 244 remote tag names observed
before the cleanup on 2026-10-19. The exact object IDs are in refs.json.
The parent links preserve every saved commit history. They do not mean that
the different implementations were integrated or verified together.

The active code remains on main and on branches with work in progress.
The ranking-restart-baseline-2026-07-23 tag remains separate.
No local working files, data downloads, caches, logs or credentials were added.

## Find or restore a branch

Fetch this archive tag. Read refs.json and find the original full ref name.
Use its commit ID to inspect the saved code with git show or git switch.
To restore a remote branch that is absent, run:

    git push --force-with-lease=refs/heads/ORIGINAL: origin COMMIT:refs/heads/ORIGINAL

Replace ORIGINAL and COMMIT with the exact values from refs.json.
The empty lease refuses to overwrite an existing branch.

## Restore an annotated tag

Each original annotated tag object is saved verbatim under tag-objects/OBJECT.
Read the original object ID from refs.json. Recreate the object with:

    git show archive/reference-snapshot-20261019:tag-objects/OBJECT | git hash-object -t tag -w --stdin

The result must equal OBJECT. For a tag that points to another tag, recreate
the referenced tag objects first. All are listed in annotatedTagObjects.
Then restore the original tag, preserving its annotation and object ID:

    git push --force-with-lease=refs/tags/ORIGINAL: origin OBJECT:refs/tags/ORIGINAL

Replace ORIGINAL and OBJECT with the exact values from refs.json.
The empty lease refuses to overwrite an existing tag.
