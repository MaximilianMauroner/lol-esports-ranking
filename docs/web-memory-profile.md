# Web service memory profile

Measured on 2026-09-29 against commit `6f5d50aa21b4afeaa96628813202cb4c5a2f7f43` before changing the Railway start command. The linked Railway service is named `web`. These results describe the server and launch process, not the ranking model or data quality.

## Production idle snapshot

The production deployment ran `pnpm run railway:start`, which left a pnpm Node process, a shell, and the app's Node process alive. After waking the service, `/proc/*/smaps_rollup` showed:

| Process | Private anonymous memory | RSS |
| --- | ---: | ---: |
| pnpm launcher (PID 1) | 95.8 MB | 150.0 MB |
| shell | 0.1 MB | 1.8 MB |
| web server | 56.8 MB | 120.5 MB |

At the same sample, cgroup `memory.current` was 223.3 MB: 156.3 MB anonymous memory, 60.5 MB file cache, and 5.2 MB kernel memory. These categories explain why summed process RSS is larger than the container figure: processes share mapped files, and RSS counts shared pages for each process. Railway's one-hour metric at the time reported 152.2 MB current and 159.8 MB maximum; Railway's metric may exclude reclaimable cache and is sampled on a different cadence.

## Isolated load comparison

Both commands ran the same checkout, Node 24.13.1, local built assets, local data, and no bucket credentials. Each received 300 successful GET requests across `/`, `/sitemap.xml`, `/data/history/team-series/All__All__All.json`, `/data/entities/players.json`, and `/api/live`, with 16 concurrent clients and gzip accepted. The table sums proportional set size (PSS) for the command's process tree, which allocates shared pages proportionally and avoids double counting. Peak was sampled during the requests; settled was sampled two seconds afterward. Runs were sequential, not simultaneous. Repeat with `python3 scripts/profile-web-memory.py` from the repository root after building `dist/`.

| Startup command | Idle PSS | Load peak PSS | Settled PSS | Requests elapsed |
| --- | ---: | ---: | ---: | ---: |
| `pnpm run railway:start` | 173.5 MiB | 237.1 MiB | 228.5 MiB | 1.85 s |
| `node scripts/railway-server.mjs` | 73.5 MiB | 131.2 MiB | 126.5 MiB | 1.84 s |
| **Direct Node reduction** | **100.1 MiB** | **105.8 MiB** | **102.0 MiB** | — |

A second run with the committed profiling script measured 158.2, 229.1, and 221.6 MiB for pnpm versus 72.7, 150.3, and 128.0 MiB for direct Node at idle, peak, and settled respectively. The observed reduction across both runs was 85–100 MiB idle, 79–106 MiB at sampled peak, and 94–102 MiB settled. Peak samples are lower bounds because polling can miss short spikes.

The idle pnpm process alone held 92.7 MB anonymous memory locally; the app process held 49.8 MB. The shell was negligible. This identifies the resident package-manager process as the largest removable cost in the current service.

A Node diagnostic report from an isolated direct-start process showed 15.95 MB used JavaScript heap and 10.16 MB external memory at idle. Immediately after the load, used heap was 14.79 MB and external memory 23.74 MB; RSS grew from 113.9 to 162.0 MB. This indicates that the load increase is not explained by used JavaScript heap alone. Buffers, V8 committed space, and allocator pages contribute. The reports were captured temporarily under `/tmp/lol-web-memory-reports/`; they are not committed because diagnostic reports can include environment details.

The change in `railway.toml` starts the same web server with `node scripts/railway-server.mjs`. It removes the pnpm and shell processes from the steady-state web container. This profile does not establish how much a service rewrite would save: after removing the launcher, the remaining idle app process uses far less memory than the old process tree, and its used heap is much smaller than its RSS. Profile the remaining dependencies and native allocations before estimating rewrite savings.

## Production after deployment

Commit `750b8fba70322bb5e20687188b3a7181b8301382` deployed successfully to both Railway services. An idle web snapshot after deployment showed one process, `node scripts/railway-server.mjs`, as PID 1. Its `/proc/1/smaps_rollup` reported 45.2 MB anonymous memory and 108.7 MB RSS. The cgroup reported 46.3 MB anonymous memory and 50.1 MB `memory.current`; Railway displayed 50.2 MB current memory. Compared with the earlier production snapshot, cgroup anonymous memory fell by about 110 MB and Railway's displayed current memory by about 102 MB. These are point-in-time observations; request traffic, cache, and sampling cadence can change the figures. The after snapshot had almost no file cache, so comparing total cgroup memory with the earlier 223.3 MB would overstate the persistent saving.

## Railway cost relevance

Railway bills [memory used while running](https://docs.railway.com/guides/right-size-cpu-memory) at approximately $10 per GB-month; sleeping services incur no resource usage. At the 2026-09-29 billing snapshot, this project's current-period memory charges were $0.0120 for `web` and $0.0081 for `ranking-refresh`. Those are usage charges, not necessarily extra invoice charges beyond a plan's included usage.

The observed 85–100 MiB web reduction would save roughly $0.9–$1.0 per month if the service ran continuously at the same reduction. Its actual savings will be lower while Railway sleeps it. The refresh cron also starts through pnpm, so `railway.refresh.toml` now launches its Node script directly. Its launcher was not separately profiled; applying the web launcher reduction to a 12-minute refresh every six hours suggests only about $0.03 per month, and that figure is an estimate, not an observed saving.

The latest refresh attempt ran for about 12 minutes and failed because its generated public data exceeded the configured 30 MB budget by 218,336 bytes. It consumed memory without publishing a new ranking generation. That failure is a separate data-budget problem; skipping required data to save memory would make rankings less accurate. Railway's raw memory chart continued to show the last refresh value after the job crashed, so billing usage and run telemetry are better evidence of its cost than that stale current-value display.
