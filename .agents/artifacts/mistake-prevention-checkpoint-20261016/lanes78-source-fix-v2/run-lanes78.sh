#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 3 ]] || exit 64
runtime_root=$1
new_output=$2
release_json=$3
package_dir=/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update/r3-lanes78-companion-fix-v2
[[ "$runtime_root" = /home/codex/.t3/worktrees/lol-esports-ranking/t3-14557610 ]] || exit 65
cd "$runtime_root"
[[ ! -e "$new_output" && -d $(dirname "$new_output") ]] || exit 65
awk '/^full / { for(i=1;i<=NF;i++) if($i ~ /^avg60=/) { split($i,a,"="); value=a[2]; found=1 } } END { print "memory_full_avg60=" value; exit !(found && value <= 5) }' /proc/pressure/memory || exit 65
awk '/^MemAvailable:/ { available=$2; found=1 } END { print "MemAvailable_MiB=" available/1024; exit !(found && available >= 1536*1024) }' /proc/meminfo || exit 65
available_kib=$(df -Pk "$(dirname "$new_output")" | awk 'NR==2 {print $4}')
[[ $available_kib -ge $((4*1024*1024)) ]] || exit 65
[[ $(node --version) = v24.* ]] || exit 65
[[ -z ${VITE_RANKING_DATA_URL:-} ]] || exit 65
sha256sum --check "$package_dir/inventory-self-sha256.txt"
sha256sum --check "$package_dir/inventory-sha256.txt"
sha256sum --check "$package_dir/external-inputs-sha256.txt"
umask 077
owned_tmp="${new_output}.tmp"
[[ ! -e "$owned_tmp" && ! -L "$owned_tmp" ]] || exit 65
mkdir -m 700 "$owned_tmp"
export TMPDIR="$owned_tmp"
export TMP="$owned_tmp"
export TEMP="$owned_tmp"
export TSX_DISABLE_CACHE=1
export NODE_DISABLE_COMPILE_CACHE=1
export NODE_COMPILE_CACHE="$owned_tmp/node-compile"
export NODE_OPTIONS=--max-old-space-size=1536
export COREPACK_ENABLE_NETWORK=0
inner_status=UNRUN
finish_owned() {
  caller_status=$?
  trap - EXIT
  set +e
  node --max-old-space-size=128 "$package_dir/cleanup-owned.mjs" "$new_output" "$owned_tmp"
  cleanup_status=$?
  printf 'lanes78_owned_cleanup_exit=%s\n' "$cleanup_status"
  printf 'lanes78_inner_exit=%s ended=%s\n' "$inner_status" "$(date -u +%FT%TZ)"
  [[ $caller_status -eq 0 ]] || exit "$caller_status"
  exit "$cleanup_status"
}
trap finish_owned EXIT
node --max-old-space-size=128 "$package_dir/dependencies-preloader.mjs" "$runtime_root" "$new_output" "$package_dir/loaded-dependency-pins.json"
printf 'lanes78_inner_start=%s root=%s output=%s\n' "$(date -u +%FT%TZ)" "$runtime_root" "$new_output"
set +e
node --import "$runtime_root/node_modules/tsx/dist/loader.mjs" "$package_dir/lanes78-driver.mjs" "$runtime_root" "$new_output" "$release_json"
inner_status=$?
set -e
exit "$inner_status"
