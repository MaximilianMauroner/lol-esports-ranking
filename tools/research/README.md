# Preserve research and check forecast parity

These offline tools retain evidence and check forecast consumers. They do not adopt a model or authorize trading.

## Import a closed study

Create a JSON spec with `schema` set to `research-intake-spec-v1`. Supply these fields.

- `sourceRoots` maps each `archive/` prefix to an absolute original directory.
- `files` maps each exact relative archive filename to `original`, `bytes`, and `sha256`. List every file you intend to preserve, including reviews and failed checks.
- `researchStatus` records the study verdict and limits. Set `modelAdopted` to `false` and `promotion` to `closed`.
- Optional `bundleDependencies` maps a dependency name to `siblingDirectory` and `manifestSha256`. The directory must be one sibling name. Keep the dependency bundle beside the new bundle.

Pin the spec SHA256 outside the destination. Freeze it before the first import.

```sh
python3 -B tools/research/intake.py freeze --root "$DESTINATION" --spec "$SPEC" --sha256 "$SPEC_SHA256"
python3 -B tools/research/intake.py import --root "$DESTINATION" --inventory "$DESTINATION/inventory.json" --sha256 "$INVENTORY_SHA256"
python3 -B tools/research/intake.py verify --root "$DESTINATION" --sha256 "$INVENTORY_SHA256"
```

The freeze output gives `manifestSha256`, which is the inventory SHA256. Import publishes the same bytes as `manifest.json`. Keep this hash outside the archive. Verification reads only the destination and its pinned sibling bundles. Import also reads and checks the original files.

The reader accepts the original `gamba-independent-intake-v1` manifest unchanged. New manifests use its same file map and bound documents. Optional external edges bind files in sibling bundles. No old manifest needs an edit.

Repeated import reuses identical files. It rejects conflicts rather than replacing them. It also recovers its own incomplete staging writes. Resume retains the first destination file identities and modification times. Do not use a different spec for an existing destination.

Freeze checks JSON `path` and `sha256` records. Every pin in `input-pins.json` and `script-pins.json` must resolve to selected or dependency bytes. The reference report separately lists unresolved historical audit pins from other files. This scan does not prove that arbitrary scripts can rerun. Review the scan and declare the combined scope before acceptance.

## Check a real forecast export

Use Node 24 with the repository's installed tsx loader. Create a `forecast-consumer-parity-v1` configuration with these fields.

- `consumer` supplies the absolute Gamba `root` and relative `sourceDigests` for `forecast-import.ts`, `contracts.ts`, and `money.ts` under `src/lol`.
- `exporter` supplies the actual Gamba export configuration. It contains `cwd`, `node`, pinned `entry`, `commit`, pinned `manifest`, pinned `requests`, pinned `candidate`, `output`, and `timeoutMs`.
- `artifacts` pins `forecast`, `manifest`, and `states`. Their paths must be the output, its `.manifest.json` sidecar, and its `.states.jsonl` sidecar.

Every file pin contains an absolute `path` and its exact `sha256`. Only consumer source digests use relative paths. Pin the configuration itself outside the export.

```sh
node --import tsx tools/research/forecast-parity.ts --config "$CONFIG" --sha256 "$CONFIG_SHA256"
```

The command calls Gamba `verifyForecastExport`, then the public Power Index predictor for every exact stored state. It binds the candidate configuration, request identities and team orientation. It compares both series probabilities, component probabilities, eligibility, exclusions and predictor versions. It supports the applied source root retained by the model-candidate exporter. It runs no ranking replay.

To create a small synthetic acceptance example, use a new output directory.

```sh
node --import tsx tools/research/synthetic-parity.ts --output "$NEW_DIRECTORY" --consumer-root "$GAMBA_ROOT"
```

This command calls the actual upstream exporter for rich and simple Elo. It covers BO1, BO3 and BO5 in both orientations. Its result records exporter replay work separately from saved-state parity. Run the reported parity configurations again to check the saved states without another replay.

Synthetic acceptance is not historical or prospective evidence. A retrospective receipt with `sourceObservedAt` after `asOf` must still fail Gamba's `NONCAUSAL_FORECAST` guard. Never change its times to make it pass.

Run the discoverable tests with the real consumer checkout available beside this repository, or set `GAMBA_CONSUMER_ROOT`.

```sh
node --import tsx --test tests/researchIntake.test.mjs tests/forecastConsumerParity.test.ts
```
