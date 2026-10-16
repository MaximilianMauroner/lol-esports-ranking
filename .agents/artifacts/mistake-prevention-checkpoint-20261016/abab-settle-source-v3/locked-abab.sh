#!/usr/bin/env bash
set -Eeuo pipefail
root=$1
head=$2
tree=$3
out=$4
unit=$5
ordinal=$6
prep=/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update/r3-abab-settle-fix-v3
cd "$root"
awk '/^full / { for(i=1;i<=NF;i++) if($i ~ /^avg60=/) { split($i,a,"="); value=a[2]; found=1 } } END { print "memory_full_avg60=" value; exit !(found && value <= 5) }' /proc/pressure/memory || { printf 'preflight_refusal stage=memory-psi exit=65\n' >&2; exit 65; }
awk '/^MemAvailable:/ { available=$2; found=1 } END { print "MemAvailable_MiB=" available/1024; exit !(found && available >= 1536*1024) }' /proc/meminfo || { printf 'preflight_refusal stage=available-memory exit=65\n' >&2; exit 65; }
[[ -z ${VITE_RANKING_DATA_URL:-} ]] || { printf 'preflight_refusal stage=ranking-data-env exit=65\n' >&2; exit 65; }
[[ $(node --version) = v24.* ]] || { printf 'preflight_refusal stage=node-version exit=65\n' >&2; exit 65; }
available_kib=$(df -Pk "$out" | awk 'NR==2 {print $4}')
[[ $available_kib -ge $((4*1024*1024)) ]] || { printf 'preflight_refusal stage=disk exit=65\n' >&2; exit 65; }
sha256sum --check "$prep/input-self-sha256.txt"
sha256sum --check "$prep/input-sha256.txt"
sha256sum --check "$prep/inventory-self-sha256.txt"
sha256sum --check "$prep/inventory-sha256.txt"
export NODE_OPTIONS=--max-old-space-size=1536
printf 'fixture_unit root=%s head=%s tree=%s unit=%s start=%s\n' "$root" "$head" "$tree" "$unit" "$(date -u +%FT%TZ)"
set +e
node "$prep/abab-driver.mjs" "$root" "$head" "$tree" "$out" "$unit" "$ordinal"
status=$?
set -e
printf 'inner_exit=%s end=%s\n' "$status" "$(date -u +%FT%TZ)"
exit "$status"
