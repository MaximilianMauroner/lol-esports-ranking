#!/usr/bin/env bash
# usage: rec.sh <name> <cwd> -- argv...
name=$1; cwd=$2; shift 3
R=/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update/r3-abab-settle-fix-review-v3/receipts
( cd "$cwd" && "$@" ) >"$R/$name.stdout" 2>"$R/$name.stderr"; code=$?
python3 -I - "$R" "$name" "$cwd" "$code" "$@" <<'PY'
import sys,json,hashlib,pathlib
R,name,cwd,code,*argv=sys.argv[1:]
h=lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
json.dump({"name":name,"cwd":cwd,"argv":argv,"exit":int(code),"stdoutSha256":h(f"{R}/{name}.stdout"),"stderrSha256":h(f"{R}/{name}.stderr")},open(f"{R}/{name}.json","w"),indent=1)
PY
echo "$name exit=$code"
