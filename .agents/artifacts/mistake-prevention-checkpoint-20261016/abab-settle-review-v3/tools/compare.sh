O=$1; N=$2
for f in abab-driver.mjs locked-abab.sh compare-abab.mjs dependency-state-pins.json input-manifest.json input-sha256.txt input-self-sha256.txt commands.md source-package.json; do
  if cmp -s "$O/$f" "$N/$f"; then echo "IDENTICAL $f $(sha256sum < $N/$f | cut -c1-64)"; else echo "DIFFERS $f old=$(sha256sum < $O/$f | cut -c1-64) new=$(sha256sum < $N/$f | cut -c1-64)"; fi
done
echo "--- full driver diff"; diff -u "$O/abab-driver.mjs" "$N/abab-driver.mjs"
echo "--- full launcher diff"; diff -u "$O/locked-abab.sh" "$N/locked-abab.sh"
echo "--- packaged diff.patch vs fresh diff (paths normalized)"
diff <( { diff -u "$O/abab-driver.mjs" "$N/abab-driver.mjs"; diff -u "$O/locked-abab.sh" "$N/locked-abab.sh"; } | grep -v '^---\|^+++' ) <(grep -v '^---\|^+++' "$N/diff.patch") && echo DIFFPATCH_MATCHES_FRESH
echo "--- metadata diff check"
diff <( for f in commands.md source-package.json input-self-sha256.txt; do diff -u "$O/$f" "$N/$f"; done | grep -v '^---\|^+++' ) <(grep -v '^---\|^+++' "$N/revision-metadata.diff") && echo METADIFF_MATCHES_FRESH
exit 0
