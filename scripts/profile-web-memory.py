"""Compare the production web entrypoint with and without the pnpm launcher.

Run from the repository root with: python3 scripts/profile-web-memory.py
Requires built dist/ and local public/data/. Uses only Python's standard library.
"""

import concurrent.futures
import glob
import json
import os
import signal
import socket
import subprocess
import time
import urllib.request


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATHS = (
    "/",
    "/sitemap.xml",
    "/data/history/team-series/All__All__All.json",
    "/data/entities/players.json",
    "/api/live",
)


def process_tree(root):
    pids = {root}
    while True:
        previous_count = len(pids)
        for filename in glob.glob("/proc/[0-9]*/status"):
            try:
                pid = int(filename.split("/")[2])
                with open(filename, encoding="utf-8") as status:
                    parent = next(
                        int(line.split()[1])
                        for line in status
                        if line.startswith("PPid:")
                    )
                if parent in pids:
                    pids.add(pid)
            except (OSError, StopIteration, ValueError):
                continue
        if len(pids) == previous_count:
            return pids


def sample(root):
    processes = []
    for pid in process_tree(root):
        try:
            with open(f"/proc/{pid}/smaps_rollup", encoding="utf-8") as source:
                fields = {
                    key: int(value.split()[0])
                    for key, value in (
                        line.split(":", 1) for line in source if ":" in line
                    )
                    if key in {"Rss", "Pss", "Anonymous"}
                }
            with open(f"/proc/{pid}/cmdline", "rb") as source:
                command = source.read().replace(b"\0", b" ").decode(errors="replace")
            processes.append({"pid": pid, "command": command, **fields})
        except OSError:
            continue
    return {
        "pss_kib": sum(item.get("Pss", 0) for item in processes),
        "anonymous_kib": sum(item.get("Anonymous", 0) for item in processes),
        "processes": processes,
    }


def request(port, path):
    target = f"http://127.0.0.1:{port}{path}"
    headers = {"Accept-Encoding": "gzip"}
    with urllib.request.urlopen(urllib.request.Request(target, headers=headers), timeout=15) as response:
        response.read()
        return response.status


def run(command, port):
    env = {
        **os.environ,
        "PORT": str(port),
        "HOST": "127.0.0.1",
        "RANKING_BUCKET_NAME": "",
        "S3_BUCKET": "",
        "BUCKET": "",
        "RANKING_REFRESH_ENABLED": "false",
    }
    child = subprocess.Popen(
        command,
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        for _ in range(100):
            try:
                request(port, "/api/live")
                break
            except Exception:
                if child.poll() is not None:
                    raise RuntimeError(f"Server exited with status {child.returncode}")
                time.sleep(0.1)
        else:
            raise RuntimeError("Server did not start")

        time.sleep(1)
        idle = sample(child.pid)
        peak = idle
        started = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            jobs = [pool.submit(request, port, PATHS[i % len(PATHS)]) for i in range(300)]
            while not all(job.done() for job in jobs):
                current = sample(child.pid)
                if current["pss_kib"] > peak["pss_kib"]:
                    peak = current
                time.sleep(0.03)
            statuses = [job.result() for job in jobs]
        duration = time.monotonic() - started
        time.sleep(2)
        return {
            "command": command,
            "idle": idle,
            "peak": peak,
            "settled": sample(child.pid),
            "duration_seconds": round(duration, 2),
            "requests": len(statuses),
            "statuses": sorted(set(statuses)),
        }
    finally:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def main():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    for command in (
        ["pnpm", "run", "railway:start"],
        ["node", "scripts/railway-server.mjs"],
    ):
        print(json.dumps(run(command, port)))


if __name__ == "__main__":
    main()
