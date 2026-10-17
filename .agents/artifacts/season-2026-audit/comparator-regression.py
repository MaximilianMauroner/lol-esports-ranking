import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile

repository = Path(__file__).resolve().parents[3]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else repository / "scripts/compare-season-matches.py"
spec = importlib.util.spec_from_file_location("comparator", source)
comparator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparator)

page = "Esports World Cup 2026/Online Qualifiers/Asia-Pacific"
series_id = "official-match\x00riot-1"
output = io.StringIO()
observations = []
for mode in ("matching-cargo", "unmapped-cargo-team", "riot-only", "liquipedia-without-cargo-score"):
    with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(output):
        root = Path(directory)
        first_team = "CTBC Flying Oyster" if mode == "matching-cargo" else "Unknown source team"
        schedule = {"MatchId": "Cargo_Week 1_1", "DateTime UTC": "2026-05-05 09:00:00",
                    "Team1": first_team, "Team2": "DetonatioN FocusMe", "Team1Score": 1,
                    "Team2Score": 0, "OverviewPage": page, "Tab": "Round 1", "BestOf": 1}
        game = {"id": "public-1", "date": "2026-05-05", "seriesId": series_id,
                "teamA": {"id": "a", "name": "CTBC Flying Oyster"},
                "teamB": {"id": "b", "name": "DetonatioN FocusMe"}, "winnerId": "a",
                "source": {"provider": "oracles-elixir", "gameId": "oracle-1", "matchId": "Cargo_Week 1_1_1"},
                "event": page, "phase": "Qualifier", "league": "EWC", "patch": "26.09", "bestOf": 1}
        values = {"public/matches.json": [game],
                  "public/catalog.json": {"seriesCount": 1, "gameCount": 1, "series": [
                      {"id": series_id, "date": game["date"], "league": "EWC", "event": page}]},
                  "cargo/games.json": [{"GameId": "Cargo_Week 1_1_1", "Team1": first_team,
                      "Team2": "DetonatioN FocusMe", "WinTeam": first_team, "Patch": "26.09",
                      "DateTime UTC": schedule["DateTime UTC"]}],
                  "cargo/MatchSchedule.json": [] if mode == "riot-only" else [schedule],
                  "cargo/Tournaments.json": [{"OverviewPage": page, "League": "Esports World Cup"}],
                  "riot/events.json": [{"startTime": "2026-05-05T09:00:00Z", "state": "completed",
                      "match": {"id": "riot-1", "teams": [
                          {"name": "CTBC Flying Oyster", "result": {"gameWins": 1}},
                          {"name": "DetonatioN FocusMe", "result": {"gameWins": 0}}]}}]}
        if mode == "liquipedia-without-cargo-score":
            body = json.dumps({"parse": {"title": "Esports World Cup/2026/APAC", "wikitext": {"*":
                "|R1M1={{Match\n|opponent1={{TeamOpponent|cfo}}\n|opponent2={{TeamOpponent|dfm}}\n"
                "|date=2026-05-05 16:00 {{Abbr/ICT}}\n|map1={{Map|winner=1 \n}}\n}}"}}}).encode()
            path = root / "secondary/liquipedia-ewc-apac.json"
            path.parent.mkdir()
            path.write_bytes(body)
            values["secondary/liquipedia-ewc-apac.json.receipt.json"] = {"sha256": hashlib.sha256(body).hexdigest()}
        for name, value in values.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value))
        rows, _, summary = comparator.compare(root)
        assert rows[0]["correctScore"] == [1, 0]
        assert summary["cargoRiotScoreAgreements"] == (1 if mode == "matching-cargo" else 0), (mode, summary)
        assert summary["uniqueCargoRiotScoreAgreements"] == (1 if mode == "matching-cargo" else 0)
        assert "source-score-conflict" not in rows[0]["issues"]
        if mode == "liquipedia-without-cargo-score":
            assert rows[0]["liquipedia"]["cargoScoreAgrees"] is None
        observations.append({"mode": mode, "passed": True})

Path(__file__).with_name("comparator-regression-output.txt").write_text(output.getvalue())
print(json.dumps(observations, indent=2))
