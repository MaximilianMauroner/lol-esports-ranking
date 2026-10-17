#!/usr/bin/env python3
"""Compare each published series with fresh Cargo and Riot evidence."""

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timedelta
import gzip
import hashlib
import html
import json
from pathlib import Path
import re


ALIASES = {
    "BRION": "HANJIN BRION", "OKSavingsBank BRION": "HANJIN BRION", "DRX": "Kiwoom DRX",
    "DN Freecs": "DN SOOPers", "Dplus Kia": "Dplus KIA", "AG.AL": "Anyone's Legend",
    "GIANTX": "GiantX", "LYON (2024 American Team)": "LYON", "MIBR.LOS": "LØS",
    "Ninjas in Pyjamas.CN": "Ninjas in Pyjamas", "Team Secret (Vietnamese Team)": "Team Secret",
    "ZEN Esports (Vietnamese Team)": "ZEN Esports", "GIANTX PRIDE": "GiantX Pride",
    "Cloud9 Kia": "Cloud9", "Team Liquid Alienware": "Team Liquid", "Gen.G Esports": "Gen.G",
    "Xi'an Team WE": "Team WE", "Beijing JDG Esports": "JD Gaming", "NAVI": "Natus Vincere",
    "Relove Deep Cross Gaming": "Deep Cross Gaming",
    "LEVIATÁN": "Leviatan",
}
LEAGUES = {
    "Americas Cup": "AC", "First Stand": "FST", "Mid-Season Invitational": "MSI",
    "World Championship": "Worlds", "Circuit Brazilian League of Legends": "CBLOL",
    "Esports World Cup": "EWC", "LoL Champions Korea": "LCK",
    "LCP Wildcard League": "LCP Wildcard", "League of Legends Championship Pacific": "LCP",
    "League of Legends Championship Series": "LCS", "LoL EMEA Championship": "LEC",
    "Tencent LoL Pro League": "LPL", "Demacia Cup": "DCup",
}


def team(value):
    value = html.unescape(value or "").strip()
    return "".join(char for char in ALIASES.get(value, value).casefold() if char.isalnum())


def pair(a, b):
    return tuple(sorted((team(a), team(b))))


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None).timestamp()


def patch(value):
    match = re.fullmatch(r"(\d+)\.(\d+)", str(value))
    if not match:
        return str(value)
    major, minor = map(int, match.groups())
    return (major + 10 if major in (15, 16) else major, minor)


def phase(value):
    value = value.lower()
    for key, pattern in [
        ("qualifier", r"qualifier"), ("play-in", r"play[ -]?in"),
        ("playoffs", r"playoffs?|final|knockout|bracket|last chance|road to"),
        ("swiss", r"swiss"), ("groups", r"group|seeding"), ("regular", r"regular|week|season"),
    ]:
        if re.search(pattern, value):
            return key
    return "round"


def liquipedia_apac(root):
    path = root / "secondary/liquipedia-ewc-apac.json"
    if not path.exists():
        return []
    body = path.read_bytes()
    receipt = json.loads(path.with_name(path.name + ".receipt.json").read_text())
    if receipt["sha256"] != hashlib.sha256(body).hexdigest():
        raise ValueError("Liquipedia capture hash mismatch")
    value = json.loads(gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body)
    if value["parse"]["title"] != "Esports World Cup/2026/APAC":
        raise ValueError("Unexpected Liquipedia tournament")
    codes = {"tsw": "Secret Whales", "dfm": "DetonatioN FocusMe", "dcg": "Deep Cross Gaming",
             "gam": "GAM Esports", "gz": "Ground Zero Gaming", "cfo": "CTBC Flying Oyster",
             "shg": "Fukuoka SoftBank HAWKS gaming", "vke": "MVK Esports"}
    result = []
    for part in re.split(r"(?=\|R\d+M\d+=\{\{Match)", value["parse"]["wikitext"]["*"])[1:]:
        opponents = re.findall(r"\|opponent[12]=\{\{TeamOpponent\|([^}|]+)", part)
        clock = re.search(r"\|date=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \{\{Abbr/ICT\}\}", part)
        if len(opponents) != 2 or clock is None:
            raise ValueError("Unsupported Liquipedia match layout")
        winners = Counter(re.findall(r"\|winner=([12])(?:\s|\|)", part))
        result.append({"id": re.search(r"\|(R\d+M\d+)", part)[1],
                       "date": str(datetime.fromisoformat(clock[1]) - timedelta(hours=7))[:10],
                       "teams": [codes[code] for code in opponents],
                       "score": [winners["1"], winners["2"]]})
    return result


def compare(directory):
    root = Path(directory)
    load = lambda name: json.loads((root / name).read_text())
    matches = load("public/matches.json")
    catalog = load("public/catalog.json")
    games = load("cargo/games.json")
    schedules = load("cargo/MatchSchedule.json")
    tournaments = {row["OverviewPage"]: row for row in load("cargo/Tournaments.json")}
    riot = {row["match"]["id"]: row for row in load("riot/events.json")}
    secondary = liquipedia_apac(root)
    originals = {}
    for item in load("oracle/team-rows.json") if (root / "oracle/team-rows.json").exists() else []:
        originals[item["row"]["gameid"]] = item["row"]
    games_by_id = {row["GameId"]: row for row in games}
    schedule_by_id = {row["MatchId"]: row for row in schedules}
    games_by_pair = defaultdict(list)
    schedules_by_pair = defaultdict(list)
    for row in games:
        games_by_pair[pair(row["Team1"], row["Team2"])].append(row)
    for row in schedules:
        schedules_by_pair[pair(row["Team1"], row["Team2"])].append(row)
    grouped = defaultdict(list)
    checked_games = []
    for row in matches:
        grouped[row["seriesId"]].append(row)
        source = row["source"]
        reference = games_by_id.get(source.get("matchId")) or games_by_id.get(source.get("gameId"))
        basis = "source-game-id" if reference else "unresolved-game"
        candidates = games_by_pair[pair(row["teamA"]["name"], row["teamB"]["name"])]
        if not reference:
            raw_time = originals.get(source.get("gameId"), {}).get("date")
            clock = raw_time or (row.get("datetimeUtc") if not row["seriesId"].startswith("official-match") else None)
            close = [game for game in candidates if clock and abs(stamp(game["DateTime UTC"]) - stamp(clock)) <= 300]
            if len(close) == 1:
                reference = close[0]
                basis = "unique-original-clock-and-teams" if raw_time else "unique-clock-and-teams"
            elif re.search(r"_game_[1-5]$", source.get("gameId", "")):
                number = source["gameId"].rsplit("_", 1)[1]
                numbered = [game for game in candidates if game["DateTime UTC"][:10] == row["date"] and game["GameId"].endswith("_" + number)]
                if len(numbered) == 1:
                    reference, basis = numbered[0], "unique-date-teams-source-game-number"
        differences = []
        winner = next(side["name"] for side in (row["teamA"], row["teamB"]) if side["id"] == row["winnerId"])
        if reference:
            if pair(row["teamA"]["name"], row["teamB"]["name"]) != pair(reference["Team1"], reference["Team2"]):
                differences.append("teams")
            if row["date"] != reference["DateTime UTC"][:10]:
                differences.append("date")
            if team(winner) != team(reference["WinTeam"]):
                differences.append("winner")
            if reference["Patch"] and patch(row["patch"]) != patch(reference["Patch"]):
                differences.append("patch")
        checked_games.append({"id": row["id"], "seriesId": row["seriesId"], "provider": source["provider"],
                              "basis": basis, "cargoGameId": reference["GameId"] if reference else None,
                              "differences": differences, "public": row, "reference": reference})
    checked_by_series = defaultdict(list)
    public_by_cargo = defaultdict(list)
    for row in checked_games:
        checked_by_series[row["seriesId"]].append(row)
        if row["cargoGameId"]:
            public_by_cargo[row["cargoGameId"]].append(row["id"])
    results = []
    for entry in catalog["series"]:
        sid = entry["id"]
        rows = grouped[sid]
        a, b = rows[0]["teamA"], rows[0]["teamB"]
        winners = Counter(row["winnerId"] for row in rows)
        shown_score = [winners[a["id"]], winners[b["id"]]]
        game_refs = checked_by_series[sid]
        candidate_ids = {row["cargoGameId"].rsplit("_", 1)[0] for row in game_refs if row["cargoGameId"]}
        refs = [schedule_by_id[key] for key in candidate_ids if key in schedule_by_id]
        schedule = refs[0] if len(refs) == 1 else None
        if not schedule and not refs:
            refs = [item for item in schedules_by_pair[pair(a["name"], b["name"])]
                    if abs((datetime.fromisoformat(item["DateTime UTC"][:10]) - datetime.fromisoformat(entry["date"])).days) <= 1]
            same_date = [item for item in refs if item["DateTime UTC"][:10] == entry["date"]]
            refs = same_date or refs
            schedule = refs[0] if len(refs) == 1 else None
        identity_conflict = False
        if not schedule and not refs:
            one_opponent = [item for item in schedules if item["DateTime UTC"][:10] == entry["date"]
                            and entry["league"] == "EWC" and item["OverviewPage"].startswith("Esports World Cup")
                            and len(set(pair(item["Team1"], item["Team2"])) & set(pair(a["name"], b["name"]))) == 1]
            if len(one_opponent) == 1:
                schedule = one_opponent[0]
                refs = one_opponent
                identity_conflict = True
        official = riot.get(sid.split("\x00", 1)[1]) if sid.startswith("official-match\x00") else None
        if not official:
            candidates = [item for item in riot.values() if len(item["match"].get("teams", [])) == 2
                          and pair(*[side["name"] for side in item["match"]["teams"]]) == pair(a["name"], b["name"])
                          and item["startTime"][:10] == entry["date"]]
            if len(candidates) == 1:
                official = candidates[0]
        expected_score = None
        correct_teams = [a["name"], b["name"]]
        if schedule:
            score_map = {team(schedule["Team1"]): schedule["Team1Score"], team(schedule["Team2"]): schedule["Team2Score"]}
            if all(score_map.get(team(side["name"])) is not None for side in (a, b)):
                expected_score = [int(score_map[team(side["name"])]) for side in (a, b)]
            elif identity_conflict:
                first = team(a["name"]) == team(schedule["Team1"]) or team(b["name"]) == team(schedule["Team2"])
                correct_teams = [schedule["Team1"], schedule["Team2"]] if first else [schedule["Team2"], schedule["Team1"]]
                scores = [int(schedule["Team1Score"]), int(schedule["Team2Score"])]
                expected_score = scores if first else list(reversed(scores))
        riot_score = None
        if official and official["state"] == "completed":
            score_map = {team(side["name"]): side.get("result", {}).get("gameWins") for side in official["match"]["teams"]}
            if all(score_map.get(team(side["name"])) is not None for side in (a, b)):
                riot_score = [score_map[team(side["name"]) ] for side in (a, b)]
        issues = []
        if identity_conflict:
            issues.append("teams-source-conflict")
        if expected_score is not None and shown_score != expected_score:
            issues.append("score")
        elif expected_score is None and riot_score is not None and shown_score != riot_score:
            issues.append("score")
        if expected_score is not None and riot_score is not None and expected_score != riot_score:
            issues.append("source-score-conflict")
        if any("patch" in row["differences"] for row in game_refs):
            issues.append("patch")
        if any("winner" in row["differences"] for row in game_refs):
            issues.append("game-winner-conflict")
        if any("teams" in row["differences"] for row in game_refs):
            issues.append("game-teams-conflict")
        if any("date" in row["differences"] for row in game_refs):
            issues.append("game-date-conflict")
        if any(len(public_by_cargo[row["cargoGameId"]]) > 1 for row in game_refs if row["cargoGameId"]):
            issues.append("duplicate-game")
        expected_league = None
        expected_stage = None
        if schedule:
            page = schedule["OverviewPage"]
            tournament = tournaments.get(page, {})
            expected_league = LEAGUES.get(tournament.get("League"), tournament.get("League"))
            if page.startswith("LPL/"):
                expected_league = "LPL"
            expected_stage = page + " / " + str(schedule["Tab"])
            shown_league = "Worlds" if entry["league"] == "WLDs" else entry["league"]
            if expected_league and shown_league != expected_league:
                issues.append("league")
            expected_phase = phase(str(schedule["Tab"]))
            if expected_phase == "round":
                explicit_stage = re.search(r"qualifier|play[ -]?in|playoffs?", page, re.IGNORECASE)
                if explicit_stage:
                    expected_phase = phase(explicit_stage.group())
            shown_phase = phase(rows[0]["phase"])
            if "qualifier" in page.lower():
                if "qualifier" not in entry["event"].lower():
                    issues.append("qualifier-as-main-event")
            elif expected_phase != "round" and shown_phase != expected_phase:
                issues.append("stage")
            best_of = schedule.get("BestOf")
            if best_of and any(row["bestOf"] != int(best_of) for row in rows):
                issues.append("best-of")
        if len(candidate_ids) > 1:
            issues.append("multiple-source-series")
        verified = schedule is not None or riot_score is not None
        providers = sorted({row["source"]["provider"] for row in rows})
        independence = "same-provider-only" if providers == ["leaguepedia-cargo"] and not official else (
            "mixed-with-source-gap" if "leaguepedia-cargo" in providers and not official else "second-provider-series")
        supplemental = None
        if schedule and schedule["OverviewPage"] == "Esports World Cup 2026/Online Qualifiers/Asia-Pacific":
            candidates = [item for item in secondary if item["date"] == schedule["DateTime UTC"][:10]
                          and set(pair(*item["teams"])) & set(pair(schedule["Team1"], schedule["Team2"]))]
            if len(candidates) == 1:
                item = candidates[0]
                first = team(a["name"]) == team(item["teams"][0]) or team(b["name"]) == team(item["teams"][1])
                score = item["score"] if first else list(reversed(item["score"]))
                supplemental = {**item, "scoreInPublicOrder": score,
                                "cargoScoreAgrees": score == expected_score if expected_score is not None else None,
                                "cargoTeamsAgree": pair(*item["teams"]) == pair(schedule["Team1"], schedule["Team2"])}
                independence = "second-provider-series" if supplemental["cargoTeamsAgree"] else "second-provider-series-team-conflict"
                if not supplemental["cargoTeamsAgree"] and "teams-source-conflict" not in issues:
                    issues.append("teams-source-conflict")
                if supplemental["cargoScoreAgrees"] is False and "source-score-conflict" not in issues:
                    issues.append("source-score-conflict")
        results.append({"seriesId": sid, "date": entry["date"], "teamA": a["name"], "teamB": b["name"],
                        "shownScore": shown_score, "cargoScore": expected_score,
                        "correctScore": expected_score if expected_score is not None else riot_score,
                        "event": entry["event"], "league": entry["league"], "phase": rows[0]["phase"],
                        "patches": sorted({row["patch"] for row in rows}), "correctLeague": expected_league,
                        "correctStage": expected_stage, "correctBestOf": schedule.get("BestOf") if schedule else None,
                        "correctTeams": correct_teams,
                        "correctPatches": sorted({row["reference"]["Patch"] for row in game_refs if row["reference"] and row["reference"]["Patch"]}),
                        "issues": issues, "status": "different" if issues else "checked" if verified else "unresolved-series",
                        "independence": independence,
                        "cargoMatchId": schedule["MatchId"] if schedule else None,
                        "riotMatchId": official["match"]["id"] if official else None,
                        "riotScore": riot_score, "providers": providers,
                        "liquipedia": supplemental,
                        "publicGameIds": [row["id"] for row in rows],
                        "unresolvedGameIds": [row["id"] for row in game_refs if not row["cargoGameId"]],
                        "candidateScheduleIds": [row["MatchId"] for row in refs]})
    if len(results) != catalog["seriesCount"] or len(matches) != catalog["gameCount"]:
        raise ValueError("Incomplete public census")
    target = root / "comparison"
    target.mkdir(exist_ok=True)
    for name, value in [("games", checked_games), ("series", results)]:
        (target / (name + ".json")).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    cargo_riot_agreements = [row for row in results if row["cargoScore"] is not None and row["riotScore"] == row["cargoScore"]]
    summary = {"games": len(matches), "series": len(results), "gameMatchBasis": dict(Counter(row["basis"] for row in checked_games)),
               "seriesStatus": dict(Counter(row["status"] for row in results)),
               "seriesIndependence": dict(Counter(row["independence"] for row in results)),
               "issueCounts": dict(Counter(issue for row in results for issue in row["issues"])),
               "cargoRiotScoreAgreements": len(cargo_riot_agreements),
               "uniqueCargoRiotScoreAgreements": len({row["cargoMatchId"] for row in cargo_riot_agreements}),
               "duplicateReferenceGames": sum(len(ids) > 1 for ids in public_by_cargo.values()),
               "duplicateExtraRows": sum(max(0, len(ids) - 1) for ids in public_by_cargo.values())}
    results_by_id = {row["seriesId"]: row for row in results}
    summary["leaguepediaGamesWithRiotSeriesReference"] = sum(
        row["provider"] == "leaguepedia-cargo" and results_by_id[row["seriesId"]]["riotMatchId"] is not None for row in checked_games)
    summary["leaguepediaGamesWithoutSecondProvider"] = sum(
        row["provider"] == "leaguepedia-cargo" and results_by_id[row["seriesId"]]["riotMatchId"] is None
        and results_by_id[row["seriesId"]]["liquipedia"] is None for row in checked_games)
    summary["leaguepediaGamesWithLiquipediaSeriesReference"] = sum(
        row["provider"] == "leaguepedia-cargo" and results_by_id[row["seriesId"]]["liquipedia"] is not None for row in checked_games)
    (target / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    for row in results:
        if row["status"] == "unresolved-series":
            print("UNRESOLVED", row["date"], row["teamA"], row["teamB"], row["candidateScheduleIds"])
    return results, checked_games, summary


def export_report(directory, destination, results, checked_games, summary):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    root = Path(directory)
    manifest = json.loads((root / "public/generation-manifest.json").read_text())
    audited_generation = "run_20261017001035_transparent-power-index-v0-2-0_fnv1a-5eebb6ce"
    if manifest["generationId"] != audited_generation:
        raise ValueError("The written root-cause report applies only to the audited generation; comparison JSON remains available")
    if not (root / "oracle/team-rows.json").exists():
        raise ValueError("Restore the raw evidence archive or supply Oracle baseline excerpts before generating the written report")
    lead_in = sum(row["public"]["date"] < "2026-01-01" for row in checked_games)
    wrong_patches = sum("patch" in row["differences"] for row in checked_games)
    unresolved_games = sum(row["cargoGameId"] is None for row in checked_games)
    missing_patches = sum(row["reference"] is not None and not row["reference"]["Patch"] for row in checked_games)
    direct_fact_differences = sum(row["basis"] == "source-game-id" and any(
        field in row["differences"] for field in ("teams", "date", "winner")) for row in checked_games)
    results_by_id = {row["seriesId"]: row for row in results}
    with (destination / "season-2026-matches.csv").open("w", newline="") as output:
        fields = ["public_game_id", "date", "team_a", "team_b", "winner", "league", "event", "phase", "patch",
                  "provider", "source_game_id", "source_match_id", "cargo_game_id", "cargo_date", "cargo_team_1", "cargo_team_2",
                  "cargo_winner", "cargo_patch", "game_identity_basis", "series_id", "shown_score", "correct_score",
                  "correct_stage", "correct_league", "cargo_match_id", "riot_match_id", "liquipedia_match_id",
                  "liquipedia_teams", "liquipedia_score", "series_reference_independence", "series_issues"]
        writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for row in checked_games:
            public, reference = row["public"], row["reference"] or {}
            series = results_by_id[row["seriesId"]]
            winner = next(side["name"] for side in (public["teamA"], public["teamB"]) if side["id"] == public["winnerId"])
            writer.writerow(dict(zip(fields, [
                row["id"], public["date"], public["teamA"]["name"], public["teamB"]["name"], winner,
                public["league"], public["event"], public["phase"], public["patch"], row["provider"],
                public["source"].get("gameId"), public["source"].get("matchId"), row["cargoGameId"],
                reference.get("DateTime UTC"), reference.get("Team1"), reference.get("Team2"), reference.get("WinTeam"), reference.get("Patch"),
                row["basis"], row["seriesId"].replace("\x00", " | "), str(series["shownScore"]), str(series["correctScore"]),
                series["correctStage"], series["correctLeague"], series["cargoMatchId"], series["riotMatchId"],
                (series["liquipedia"] or {}).get("id"), (series["liquipedia"] or {}).get("teams"),
                (series["liquipedia"] or {}).get("scoreInPublicOrder"), series["independence"], ", ".join(series["issues"]),
            ])))
    wrong = [row for row in results if row["issues"]]
    lines = [
        "# 2026 season match audit", "",
        f"The deployed season scope has {summary['games']:,} games in {summary['series']:,} displayed series. The script flags {len(wrong)} series for correction or source review.", "",
        "The complete game list is in [season-2026-matches.csv](season-2026-matches.csv). Each row includes the public values, source game IDs, reference values, and series findings.", "",
        f"The audit pins generation `{manifest['generationId']}`, generated at `{manifest['generatedAt']}`. The model is `{manifest['model']['version']}` with config `{manifest['model']['configHash']}`.", "",
        f"The scope includes {lead_in} December 2025 lead-in games. The collector follows the deployed season catalog and its immutable object hashes. It does not scrape the site UI.", "",
        "## Findings", "",
        "Counts overlap because one displayed series can have several faults.", "",
        "| Finding | Displayed series |", "| --- | ---: |",
    ]
    lines.extend(f"| {issue} | {count} |" for issue, count in summary["issueCounts"].items())
    lines.extend([
        "",
        f"There are {summary['duplicateExtraRows']} extra published rows for {summary['duplicateReferenceGames']} paired reference games. There are {wrong_patches} wrong patch rows in {summary['issueCounts'].get('patch', 0)} series. Direct game-ID checks found {direct_fact_differences} team, UTC date, or winner differences after the listed brand aliases were applied.", "",
        "Oracle's `16.xx` patch notation and Leaguepedia's `26.xx` notation describe the same 2026 patch. These are not counted as errors. `26.1` versus `26.10` is a retained precision error.", "",
        "Seven displayed EWC qualifier series have a team-source conflict across four source matches. Three Oracle-derived series name Team Secret Whales. Cargo names Team Secret (Vietnamese Team), and the three repeated Leaguepedia-derived series show Team Secret. These three apparent repeated series contain seven candidate extra games outside the count of 80 directly paired extra rows. Their dates, common opponent, series scores, and Cargo match IDs agree, but the seven Oracle game ordinals remain unpaired. The May 20 Oracle-derived series also names Team Secret. Liquipedia names Secret Whales in all four source matches and agrees with Cargo's dates and scores. The wiki API gives Team Secret and Team Secret Whales distinct page IDs. The patch keeps this conflict open and does not merge their identities.", "",
        "## Root causes and fixes", "",
        "1. The deployed duplicates show a failed cross-provider link. Exact kills and gold are the current primary link key. A synthetic stat revision proves one way this path can retain two rows and create an orphan Oracle Bo1. This is a demonstrated failure mode, not the confirmed trigger for every deployed duplicate. The retained local baseline has identical Oracle and Leaguepedia stats for all 77 duplicate pairs it covers. The production source delta remains unknown. The code change handles valid stat revisions with unique declared game slots after exact-stat matching. It requires matching date, teams, winner, league, season, and compatible clocks. Ambiguous games remain separate. A full production repair is not certified.", "",
        "2. Source-series grouping included the UTC date. Schedule enrichment also matched by date, so only the first game of some overnight series received an official ID. FURIA versus MVK on October 15 and 16 appears as 0-1 and 0-2 instead of one 0-3 result. The fix groups explicit source series IDs across dates and shares a unique official anchor within a verified source series. Conflicting official IDs remain separate. Declared series-level IDs keep their numeric match suffixes. Date grouping remains for games without a source series ID.", "",
        "3. Historical Leaguepedia snapshots stored patch `26.10` as string `26.1`. The importer kept that loss. The fix restores trailing zeros for calendar patch numbers from 25 onward. It handles numeric and string input and preserves older patch schemes.", "",
        "4. The league matcher found `LCP` inside `LCP Wildcard`. This admitted 29 games in six feeder playoff series to the flagship rating universe. The fix recognizes LCP Wildcard before LCP. The existing universe filter then excludes those rows.", "",
        "5. Oracle's playoff flag reduces stages to Playoffs or Regular season. Leaguepedia ingestion infers stage and best-of from text instead of reading MatchSchedule. This causes stage and format faults. The proposed next fix is to ingest MatchSchedule stage and best-of with stable series IDs, then apply that metadata only after a verified game link. Both Node and Rust fetchers must use the same contract. This PR does not guess missing stage metadata.", "",
        "6. Raw manifest refresh unions old and new overlapping files. Same-provider duplicates keep the first imported row. The proposed next fix is to make snapshot-window replacement and source freshness explicit, including tombstones for removed games. This is a code-backed risk. This audit did not prove that retention created a listed result fault.", "",
        "The original Oracle baseline reproduces two correct Gen.G versus DRX games on January 15. A synthetic one-gold revision reproduces the deployed three-row shape before the fix and two rows after it. The exact production stat difference is not known. Both public Drive download forms returned quota-exceeded HTML. The report does not claim that Oracle invented the match.", "",
        "## Provenance", "",
        "Oracle rows enter through `importOraclesElixirCsv` in `src/lib/importers/oraclesElixir.ts`. Leaguepedia rows enter through `importLeaguepediaSnapshot` in `src/lib/importers/leaguepedia.ts`. `scripts/ranking-source-import.ts` loads the manifest in order. `mergeCommunityMatchSources` retains Oracle first and adds Leaguepedia gaps. `resolveCanonicalSeries` computes series scores. `src/lib/snapshot.ts` publishes those scores and source labels.", "",
        "For duplicate and score faults, the bad displayed record comes from this merge or grouping step. For patch faults, the retained Leaguepedia snapshot and importer supply the bad value. For the six league faults, Leaguepedia's LCP Wildcard page is correct and the local taxonomy introduces the wrong LCP label. The table records the contributing providers for every flagged series.", "",
        "The public rows omit source filename and enrichment history. The retained local excerpts identify baseline rows where available. Exact production-row attribution after the local Oracle baseline ends on July 10 is limited to the public provider and game ID. Production cache access or a later successful source download is needed for stronger attribution.", "",
        "## Evidence and limits", "",
        f"The collector retains fresh Cargo ScoreboardGames CSV, MatchSchedule, tournament metadata, and Riot schedule JSON. Riot independently agrees with Cargo's series score for {summary['uniqueCargoRiotScoreAgreements']} unique Cargo series. These references cover {summary['cargoRiotScoreAgreements']} displayed series because some source series appear more than once.", "",
        f"Of 132 Leaguepedia-sourced public games, {summary['leaguepediaGamesWithRiotSeriesReference']} have a second-provider Riot series reference. A retained Liquipedia APAC capture gives date and score references for {summary['leaguepediaGamesWithLiquipediaSeriesReference']} more games, with the team conflict described above. The remaining {summary['leaguepediaGamesWithoutSecondProvider']} have fresh Cargo rechecks only. They are 29 LCP Wildcard games and one December Demacia game. Games of Legends returned no usable match list for these events, and Liquipedia search found no LCP Wildcard event. These rows cannot be certified against a second provider in this run.", "",
        f"All {summary['series']:,} displayed series were compared. Per-game rows are paired for {summary['games'] - unresolved_games:,} of {summary['games']:,} rows. Exactly {summary['gameMatchBasis'].get('source-game-id', 0):,} pair by source game ID. The other pairings use unique clocks and teams or source game numbers. The remaining {unresolved_games} have series-level checks only, often because scheduled series start replaced the original game clock. These checks do not prove each game ordinal. {missing_patches} games have no patch in fresh Cargo and remain unverified for that field. The CSV labels same-provider rechecks separately. No missing reference is treated as a clean pass.", "",
        "The stage flags use explicit stage words in MatchSchedule tabs or playoff and play-in paths. Generic Round and Day labels remain unknown. The 120 stage flags are heuristic candidates for correction, not a complete stage certification.", "",
        "Raw downloads, request URLs, hashes, source excerpts, comparison JSON, and check output stay under `.agents/artifacts/season-2026-audit/`. Raw evidence stays local and is not tracked by Git. The local archive preserves the inputs used by this report. Source data is an audit capture, not a refreshed production dataset.", "",
        "With the retained local evidence, reproduce the audit from the repository root. The archive includes the optional original Oracle clock excerpts.", "", "```sh",
        "tar -xzf .agents/artifacts/season-2026-audit/raw-evidence.tar.gz -C .",
        "python3 scripts/compare-season-matches.py --report-dir reports",
        "heavy-check -- pnpm run verify", "```", "",
        "Collect a later public generation with `python3 scripts/audit-season-matches.py --output <new-directory>`. Pass that directory to the comparator with `--evidence`. Optional `--oracle-baseline <csv>` arguments retain original clocks and source receipts. Without those excerpts, game identity coverage can be lower. The written root-cause report is restricted to the audited generation; comparison JSON works for later captures.", "",
        "## Verification and handoff", "",
        "The initial full local verification failed. It passed typecheck and lint, then recorded 1,208 passed, seven failed, and 21 skipped tests out of 1,236. Source edits occurred during that run, so it has no single verified commit and gives no current-head verification credit. The raw output is retained. Later fixes address those failures. Final focused checks, player-output parity, full verification, and bundle validation await a host allocation. The PR body records the results. Raw check output stays in the local evidence directory. Hosted Actions is billing-blocked. All branch commits use `[skip ci]`; no workflow is dispatched.", "",
        "The focused replay uses an unchanged checkout at `904919f97b8059b2b152ae2c40d699c187e47178`. Create one with `git worktree add --detach /tmp/lol-2026-audit-baseline 904919f97b8059b2b152ae2c40d699c187e47178`, provide its dependencies, and extract the archive first. Then run `heavy-check -- bash .agents/artifacts/season-2026-audit/final-focused.sh`. The harness stays local with the evidence. It accepts a different baseline path as its first argument and performs no dependency install.", "",
        "Merging this code does not repair the live public objects. A full raw-data replay and a later approved publication are required. Rankings and series IDs can change. The new taxonomy also changes the model config hash. No merge, deployment, force-push, or rebase of a pushed branch is authorized.", "",
        "Max owns acceptance and the decision to permit a later production replay. The maintainer owns the stage and format ingest change, the four source-match team identity conflicts, and the remaining independent-source checks. A later schema change can store series IDs and game numbers separately to remove consumer suffix guesses. It changes stored public IDs and is outside this repair.", "",
        "## Every flagged displayed series", "",
        "Each correction uses the public team order. A team conflict names the source's correct team pair. The full CSV contains the exact source game IDs for each row.", "",
        "| Date | Shown | Correct score and teams | Correct event or stage | Faults | Bad record path | Reference |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ])
    def clean(value):
        return str(value).replace("|", "&#124;").replace("\n", " ")
    for row in wrong:
        shown = f"{row['teamA']} {row['shownScore'][0]}-{row['shownScore'][1]} {row['teamB']}; {row['event']}; {row['phase']}; patch {', '.join(row['patches'])}"
        score = row["correctScore"]
        correct = f"{row['correctTeams'][0]} {score[0]}-{score[1]} {row['correctTeams'][1]}" if score else "Score unresolved"
        if "patch" in row["issues"]:
            correct += "; patch " + ", ".join(row["correctPatches"])
        if row["liquipedia"] and not row["liquipedia"]["cargoTeamsAgree"]:
            correct = "Cargo: " + correct + "; Liquipedia: " + " vs ".join(row["liquipedia"]["teams"]) + " (identity unresolved)"
        provider = " + ".join("Oracle" if item == "oracles-elixir" else "Leaguepedia" for item in row["providers"])
        step = "merge or series grouping" if any(issue in row["issues"] for issue in ("score", "duplicate-game")) else "stage inference"
        if "teams-source-conflict" in row["issues"]:
            step = "source team identity or cross-provider merge"
        if "league" in row["issues"]:
            step = "league inference"
        elif "patch" in row["issues"] and len(row["issues"]) == 1:
            step = "patch ingest"
        reference = row["cargoMatchId"] or "Riot " + str(row["riotMatchId"])
        if row["liquipedia"]:
            reference += "; Liquipedia EWC/APAC " + row["liquipedia"]["id"]
        lines.append("| " + " | ".join(map(clean, [row["date"], shown, correct,
                     row["correctStage"], ", ".join(row["issues"]), provider + "; " + step, reference])) + " |")
    (destination / "season-2026-match-audit.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", default=".agents/artifacts/season-2026-audit")
    parser.add_argument("--report-dir")
    args = parser.parse_args()
    results, checked_games, summary = compare(args.evidence)
    if args.report_dir:
        export_report(args.evidence, args.report_dir, results, checked_games, summary)
