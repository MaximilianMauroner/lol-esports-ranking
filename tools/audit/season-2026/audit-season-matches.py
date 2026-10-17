#!/usr/bin/env python3
"""Retain public match artifacts and fresh Cargo rows for a season audit."""

import argparse
import csv
import gzip
import hashlib
import json
import io
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

PUBLIC_RIOT_API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"


class Evidence:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def get(self, url, name, headers=None):
        path = self.directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            receipt_path = path.with_name(path.name + ".receipt.json")
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text())
                body = path.read_bytes()
                if receipt["url"] != url or receipt["sha256"] != hashlib.sha256(body).hexdigest():
                    raise ValueError("Cached evidence identity mismatch " + name)
                return body
        request = urllib.request.Request(url, headers={
            "User-Agent": "lol-esports-audit/1.0",
            "Accept-Encoding": "identity", **(headers or {}),
        })
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    body = response.read()
                    receipt = {"url": url, "status": response.status,
                               "headers": dict(response.headers),
                               "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                               "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)}
                path.write_bytes(body)
                path.with_name(path.name + ".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
                return body
            except urllib.error.HTTPError as error:
                failure = {"url": url, "status": error.code, "body": error.read().decode(errors="replace")}
                path.with_name(path.name + ".failure.json").write_text(json.dumps(failure, indent=2) + "\n")
                if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("Request failed")

    def json(self, url, name, headers=None):
        body = self.get(url, name, headers)
        return json.loads(gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body)

    def write(self, name, value):
        path = self.directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def collect_public(evidence, base, season):
    manifest = evidence.json(base + "/data/ranking-summary.json", "public/generation-manifest.json")

    def object_value(reference):
        digest = reference["sha256"]
        body = evidence.get(base + "/data/objects/sha256/" + digest, "public/objects/" + digest + ".gz")
        if hashlib.sha256(body).hexdigest() != digest or len(body) != reference["bytes"]:
            raise ValueError("Public object identity mismatch " + digest)
        return json.loads(gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body)

    def hydrate(value):
        if value.get("artifactKind") == "public-semantic-artifact":
            return hydrate(value["content"])
        if value.get("artifactKind") in ("public-artifact-archive", "public-archive-node"):
            return tree(value["tree"])
        return value

    def tree(node):
        if node["kind"] == "inline":
            return node["value"]
        if node["kind"] == "record":
            return {key: tree(child) for key, child in node["entries"]}
        result = [] if node["kind"] == "list" else {}
        for reference in node["parts"]:
            child = hydrate(object_value(reference))
            if len(child) != reference["count"]:
                raise ValueError("Archive count mismatch")
            if isinstance(result, list):
                result.extend(child)
            else:
                if result.keys() & child.keys():
                    raise ValueError("Duplicate archive keys")
                result.update(child)
        return result

    def logical(path):
        return hydrate(object_value(manifest["artifacts"][path]))

    index = logical("/data/matches/index.json")
    evidence.write("public/match-index.json", index)
    key = season + "__All__All"
    scope = index["scopeIndex"].get(key, index["scopeIndex"]["All__All__All"])
    catalog = logical(scope["url"])
    evidence.write("public/catalog.json", catalog)
    series = catalog["series"] if key in index["scopeIndex"] else [
        row for row in catalog["series"] if row.get("storageYear", row["date"][:4]) == season]
    page_ids = {row["page"] for row in series}
    pages = [page for page in catalog["pages"] if page["page"] in page_ids]
    matches = []
    for page in pages:
        value = logical(page["url"])
        if value["gameCount"] != len(value["matches"]):
            raise ValueError("Page game count mismatch")
        matches.extend(value["matches"])
    selected_ids = {row["id"] for row in series}
    matches = [row for row in matches if row["seriesId"] in selected_ids]
    if len(matches) != sum(row["gameCount"] for row in series):
        raise ValueError("Catalog game count mismatch")
    if len({row["id"] for row in matches}) != len(matches):
        raise ValueError("Duplicate public game IDs")
    evidence.write("public/matches.json", matches)
    evidence.write("public/series.json", series)
    evidence.write("public/teams.json", logical("/data/entities/teams.json"))
    evidence.write("public/summary.json", logical(manifest["rootArtifact"]))
    print(f"Public {season}: {len(matches)} games, {len(series)} series, {len(pages)} pages", flush=True)
    return matches


def collect_cargo(evidence, season, end, start=None):
    start = start or season + "-01-01"
    fields = "OverviewPage,Team1,Team2,WinTeam,LossTeam,DateTime_UTC,Patch,GameId"
    rows = []
    for offset in range(0, 100000, 500):
        params = {"tables": "ScoreboardGames", "fields": fields,
                  "where": f'DateTime_UTC >= "{start} 00:00:00" AND DateTime_UTC <= "{end} 23:59:59" AND Team1 IS NOT NULL AND Team2 IS NOT NULL AND WinTeam IS NOT NULL',
                  "order_by": "DateTime_UTC ASC,GameId ASC", "limit": "500", "offset": str(offset), "format": "csv"}
        url = "https://lol.fandom.com/wiki/Special:CargoExport?" + urllib.parse.urlencode(params)
        body = evidence.get(url, f"cargo/scoreboard-{start}-{offset:06}.csv")
        reader = csv.DictReader(io.StringIO(body.decode("utf-8-sig")))
        if not set(fields.replace("_", " ").split(",")).issubset(reader.fieldnames or []):
            raise ValueError("Unexpected Cargo CSV headers")
        page = list(reader)
        rows.extend(page)
        print(f"Cargo: {len(rows)} games", flush=True)
        if len(page) < 500:
            break
        time.sleep(1.3)
    else:
        raise ValueError("Cargo safety page limit reached")
    if len({row["GameId"] for row in rows}) != len(rows):
        raise ValueError("Cargo game IDs are not unique")
    evidence.write("cargo/games.json", rows)
    return rows


def collect_metadata(evidence, games):
    pages = sorted({game["OverviewPage"] for game in games})
    result = {}
    for table, fields, order in [
        ("Tournaments", "OverviewPage,League,Name,Year,TournamentLevel,Region", "OverviewPage ASC"),
        ("MatchSchedule", "OverviewPage,MatchId,Team1,Team2,Team1Score,Team2Score,Winner,DateTime_UTC,BestOf,Tab,IsNullified", "MatchId ASC"),
    ]:
        rows = []
        for batch in range(0, len(pages), 25):
            selected = ",".join('"' + page.replace('"', '\\"') + '"' for page in pages[batch:batch + 25])
            for offset in range(0, 20000, 500):
                params = {"tables": table, "fields": fields, "where": "OverviewPage IN (" + selected + ")",
                          "order_by": order, "limit": "500", "offset": str(offset), "format": "json"}
                url = "https://lol.fandom.com/wiki/Special:CargoExport?" + urllib.parse.urlencode(params)
                query_key = hashlib.sha256(selected.encode()).hexdigest()[:12]
                page = evidence.json(url, f"cargo/{table}-{query_key}-{offset:06}.json")
                if not isinstance(page, list):
                    raise ValueError("Cargo metadata did not return rows")
                rows.extend(page)
                if len(page) < 500:
                    break
                time.sleep(1.3)
            time.sleep(1.3)
        evidence.write(f"cargo/{table}.json", rows)
        result[table] = rows
        print(f"Cargo {table}: {len(rows)} rows", flush=True)
    return result


def collect_riot(evidence, start):
    base = "https://esports-api.lolesports.com/persisted/gw/"
    headers = {"x-api-key": PUBLIC_RIOT_API_KEY}
    leagues = evidence.json(base + "getLeagues?hl=en-US", "riot/leagues.json", headers)["data"]["leagues"]
    names = {"Worlds", "MSI", "First Stand", "LCS", "Americas Cup", "LEC", "LCK", "LPL", "LCP", "CBLOL", "Esports World Cup"}
    ids = ",".join(league["id"] for league in leagues if league["name"] in names)
    events = {}
    token = None
    seen_tokens = set()
    for page in range(100):
        params = {"hl": "en-US", "leagueId": ids}
        if token:
            params["pageToken"] = token
        response = evidence.json(base + "getSchedule?" + urllib.parse.urlencode(params),
                                 f"riot/schedule-{hashlib.sha256(ids.encode()).hexdigest()[:12]}-{page:03}.json", headers)["data"]["schedule"]
        selected = response.get("events", [])
        for event in selected:
            if event.get("match", {}).get("id"):
                events[event["match"]["id"]] = event
        earliest = min((event["startTime"][:10] for event in selected), default="")
        print(f"Riot: {len(events)} series, earliest {earliest}", flush=True)
        token = response.get("pages", {}).get("older")
        if not token or earliest < start:
            break
        if token in seen_tokens:
            raise ValueError("Riot schedule pagination cycle")
        seen_tokens.add(token)
        time.sleep(0.35)
    else:
        raise ValueError("Riot schedule page limit reached")
    evidence.write("riot/events.json", list(events.values()))
    return list(events.values())


def collect_oracle_excerpts(evidence, matches, paths):
    ids = {row["source"].get("gameId") for row in matches if row["source"]["provider"] == "oracles-elixir"}
    excerpts, receipts = [], []
    for path in paths:
        path = Path(path).resolve()
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        with path.open(encoding="utf-8-sig", newline="") as source:
            for line, row in enumerate(csv.DictReader(source), 2):
                if row.get("gameid") in ids and row.get("position") == "team":
                    excerpts.append({"file": str(path), "line": line, "row": row})
        receipts.append({"path": str(path), "sha256": digest.hexdigest(), "bytes": path.stat().st_size})
    evidence.write("oracle/team-rows.json", excerpts)
    evidence.write("oracle/receipts.json", receipts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=".agents/artifacts/season-2026-audit")
    parser.add_argument("--base-url", default="https://lol.lab4code.com")
    parser.add_argument("--season", default="2026")
    parser.add_argument("--end", default="2026-10-17")
    parser.add_argument("--public-only", action="store_true")
    parser.add_argument("--oracle-baseline", action="append", default=[])
    args = parser.parse_args()
    evidence = Evidence(args.output)
    matches = collect_public(evidence, args.base_url.rstrip("/"), args.season)
    if args.oracle_baseline:
        collect_oracle_excerpts(evidence, matches, args.oracle_baseline)
    if not args.public_only:
        games = collect_cargo(evidence, args.season, args.end, min(row["date"] for row in matches))
        source_ids = {row["source"].get(key) for row in matches for key in ("gameId", "matchId")}
        linked_pages = {row["OverviewPage"] for row in games if row["GameId"] in source_ids}
        collect_metadata(evidence, [game for game in games if game["OverviewPage"] in linked_pages])
        collect_riot(evidence, min(row["date"] for row in matches))


if __name__ == "__main__":
    main()
