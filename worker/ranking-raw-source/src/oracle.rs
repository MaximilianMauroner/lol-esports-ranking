use crate::{Result, digest, ensure, types::*, validate};
use ranking_contracts::compare_code_units;
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};

pub struct Source {
    pub name: String,
    pub importer: String,
    pub header: Vec<String>,
    pub header_digest: String,
    pub games: Vec<Game>,
    pub digest: String,
}

impl Source {
    pub fn inventory(&self) -> Vec<InventoryGame> {
        self.games.iter().map(Game::inventory).collect()
    }
    pub fn baseline(&self) -> serde_json::Value {
        json!({"artifactKind":BASELINE_KIND,"schemaVersion":1,"importerVersion":self.importer,
            "sourceFileName":self.name,"header":self.header,"headerDigest":self.header_digest,
            "oracleDigest":self.digest,"games":self.games})
    }
}

fn indexes(header: &[String]) -> Result<[usize; 4]> {
    validate::header(header)?;
    let map = header
        .iter()
        .enumerate()
        .map(|(i, k)| (validate::trim(k).to_lowercase(), i))
        .collect::<HashMap<_, _>>();
    let mut indexes = [0; 4];
    for (slot, key) in indexes.iter_mut().zip(["gameid", "date", "league", "side"]) {
        *slot = *map
            .get(key)
            .ok_or_else(|| format!("Oracle header missing {key}"))?;
    }
    Ok(indexes)
}

fn normalize_date(value: &str) -> Result<String> {
    let text = validate::trim(value);
    let prefix = text.get(..10).ok_or("Incomplete Oracle date")?;
    validate::date(prefix)?;
    Ok(prefix.into())
}

fn validate_game(game: &mut Game, header: &[String], positions: [usize; 4]) -> Result<()> {
    validate::nonempty(&game.game_id, "gameId")?;
    validate::nonempty(&game.league, "league")?;
    validate::date(&game.date)?;
    ensure(
        game.source_order <= 9_007_199_254_740_991,
        "Invalid source order",
    )?;
    ensure(game.rows.len() >= 2, "Incomplete Oracle game")?;
    let [id, date, league, side] = positions;
    let mut sides = HashSet::new();
    for row in &game.rows {
        ensure(
            row.len() == header.len(),
            "Oracle row/header length mismatch",
        )?;
        ensure(
            validate::trim(&row[id]) == game.game_id
                && normalize_date(&row[date])? == game.date
                && validate::trim(&row[league]) == game.league,
            "Inconsistent Oracle game identity",
        )?;
        sides.insert(validate::trim(&row[side]).to_lowercase());
    }
    ensure(
        sides.contains("blue") && sides.contains("red"),
        "Oracle game missing both sides",
    )?;
    game.digest = digest(
        &json!({"gameId":game.game_id,"date":game.date,"league":game.league,"sourceOrder":game.source_order,"rows":game.rows}),
    );
    Ok(())
}

pub fn parse_csv(csv: &str, name: &str, importer: &str) -> Result<Source> {
    validate::filename(name)?;
    validate::nonempty(importer, "importerVersion")?;
    let mut rows = CsvRows::new(csv);
    let header = rows.next().ok_or("Missing Oracle CSV header")??;
    let positions = indexes(&header)?;
    let [id, date, league, _] = positions;
    let mut by_id = HashMap::<String, usize>::new();
    let mut games = Vec::<Game>::new();
    for row in rows {
        let row = row?;
        if row.len() == 1 && row[0].is_empty() {
            continue;
        }
        ensure(row.len() == header.len(), "Oracle CSV field count mismatch")?;
        let game_id = validate::trim(&row[id]).to_owned();
        let day = normalize_date(&row[date])?;
        let region = validate::trim(&row[league]).to_owned();
        validate::nonempty(&game_id, "gameId")?;
        validate::nonempty(&region, "league")?;
        let index = if let Some(index) = by_id.get(&game_id) {
            *index
        } else {
            let index = games.len();
            by_id.insert(game_id.clone(), index);
            games.push(Game {
                game_id,
                date: day.clone(),
                league: region.clone(),
                source_order: index as u64,
                rows: Vec::new(),
                digest: String::new(),
            });
            index
        };
        ensure(
            games[index].date == day && games[index].league == region,
            "Ambiguous Oracle game date/league",
        )?;
        games[index].rows.push(row);
    }
    ensure(!games.is_empty(), "Oracle CSV has no complete games")?;
    for game in &mut games {
        validate_game(game, &header, positions)?;
    }
    let header_digest = digest(&serde_json::to_value(&header)?);
    let inventory = games.iter().map(Game::inventory).collect::<Vec<_>>();
    let digest = validate::source_digest(name, importer, &header_digest, &inventory);
    Ok(Source {
        name: name.into(),
        importer: importer.into(),
        header,
        header_digest,
        games,
        digest,
    })
}

pub fn parse_baseline(mut value: serde_json::Value, importer: &str) -> Result<Source> {
    if let Some(games) = value["games"].as_array_mut() {
        for (index, game) in games.iter_mut().enumerate() {
            if let Some(object) = game.as_object_mut()
                && object
                    .get("sourceOrder")
                    .is_none_or(|value| value.is_null())
            {
                object.insert("sourceOrder".into(), json!(index));
            }
        }
    }
    let mut baseline: Baseline = serde_json::from_value(value)?;
    ensure(
        baseline.artifact_kind == BASELINE_KIND && baseline.schema_version == 1,
        "Unsupported Oracle baseline",
    )?;
    ensure(
        baseline.importer_version == importer,
        "Oracle importer version mismatch",
    )?;
    validate::filename(&baseline.source_file_name)?;
    let positions = indexes(&baseline.header)?;
    ensure(
        digest(&serde_json::to_value(&baseline.header)?) == baseline.header_digest,
        "Oracle header digest mismatch",
    )?;
    ensure(!baseline.games.is_empty(), "Oracle baseline has no games")?;
    let mut seen = HashSet::new();
    for game in &mut baseline.games {
        validate_game(game, &baseline.header, positions)?;
        ensure(seen.insert(&game.game_id), "Duplicate Oracle game")?;
    }
    ensure(
        baseline
            .games
            .windows(2)
            .all(|pair| order(&pair[0], &pair[1]).is_le()),
        "Unsorted Oracle games",
    )?;
    let inventory = baseline
        .games
        .iter()
        .map(Game::inventory)
        .collect::<Vec<_>>();
    let digest = validate::source_digest(
        &baseline.source_file_name,
        importer,
        &baseline.header_digest,
        &inventory,
    );
    ensure(
        digest == baseline.oracle_digest,
        "Oracle baseline digest mismatch",
    )?;
    Ok(Source {
        name: baseline.source_file_name,
        importer: baseline.importer_version,
        header: baseline.header,
        header_digest: baseline.header_digest,
        games: baseline.games,
        digest,
    })
}

fn order(left: &Game, right: &Game) -> std::cmp::Ordering {
    left.source_order
        .cmp(&right.source_order)
        .then_with(|| compare_code_units(&left.game_id, &right.game_id))
}

pub fn mutation_chain(previous: &OracleReceipt, next: &Source) -> Result<Vec<Delta>> {
    ensure(
        validate::source_digest(
            &previous.source_file_name,
            &next.importer,
            &previous.header_digest,
            &previous.game_inventory,
        ) == previous.effective_oracle_digest,
        "Previous Oracle importer compatibility mismatch",
    )?;
    ensure(
        previous.header_digest == next.header_digest && previous.source_file_name == next.name,
        "Oracle source compatibility mismatch",
    )?;
    let old = previous
        .game_inventory
        .iter()
        .map(|g| (g.game_id.as_str(), g))
        .collect::<HashMap<_, _>>();
    let new = next
        .games
        .iter()
        .map(|g| (g.game_id.as_str(), g))
        .collect::<HashMap<_, _>>();
    let mut mutations = Vec::new();
    for game in &previous.game_inventory {
        match new.get(game.game_id.as_str()) {
            None => mutations.push((
                game.date.clone(),
                game.league.clone(),
                Mutation::Delete {
                    game_id: game.game_id.clone(),
                    expected_previous_digest: game.digest.clone(),
                },
            )),
            Some(replacement) if replacement.digest != game.digest => mutations.push((
                replacement.date.clone(),
                replacement.league.clone(),
                Mutation::Replace {
                    game_id: game.game_id.clone(),
                    expected_previous_digest: game.digest.clone(),
                    game: (**replacement).clone(),
                },
            )),
            _ => {}
        }
    }
    for game in &next.games {
        if !old.contains_key(game.game_id.as_str()) {
            mutations.push((
                game.date.clone(),
                game.league.clone(),
                Mutation::Add {
                    game_id: game.game_id.clone(),
                    game: game.clone(),
                },
            ));
        }
    }
    // Node sorts the joined partition key before grouping; league can contain non-ASCII.
    mutations.sort_by(|a, b| {
        compare_code_units(&format!("{}\0{}", a.0, a.1), &format!("{}\0{}", b.0, b.1))
            .then_with(|| compare_code_units(a.2.game_id(), b.2.game_id()))
    });
    let mut inventory = previous
        .game_inventory
        .iter()
        .map(|g| (g.game_id.clone(), g.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut current_digest = previous.effective_oracle_digest.clone();
    let mut deltas = Vec::new();
    let mut grouped = Vec::<Mutation>::new();
    let mut partition: Option<(String, String)> = None;
    for (date, league, mutation) in mutations {
        if partition
            .as_ref()
            .is_some_and(|p| p.0 != date || p.1 != league)
        {
            let p = partition.take().expect("partition exists");
            deltas.push(make_delta(
                next,
                p,
                std::mem::take(&mut grouped),
                &mut inventory,
                &mut current_digest,
            )?);
        }
        partition = Some((date, league));
        grouped.push(mutation);
    }
    if let Some(p) = partition {
        deltas.push(make_delta(
            next,
            p,
            grouped,
            &mut inventory,
            &mut current_digest,
        )?);
    }
    let mut effective = inventory.into_values().collect::<Vec<_>>();
    effective.sort_by(validate::game_order);
    ensure(
        current_digest == next.digest && effective == next.inventory(),
        "Oracle mutation chain does not reconstruct source",
    )?;
    Ok(deltas)
}

fn make_delta(
    next: &Source,
    partition: (String, String),
    mutations: Vec<Mutation>,
    inventory: &mut BTreeMap<String, InventoryGame>,
    current_digest: &mut String,
) -> Result<Delta> {
    let previous_digest = current_digest.clone();
    for mutation in &mutations {
        match mutation {
            Mutation::Add { game_id, game } => {
                ensure(
                    !inventory.contains_key(game_id),
                    "Oracle inventory add already exists",
                )?;
                inventory.insert(game_id.clone(), game.inventory());
            }
            Mutation::Replace {
                game_id,
                expected_previous_digest,
                game,
            } => {
                ensure(
                    inventory
                        .get(game_id)
                        .is_some_and(|g| &g.digest == expected_previous_digest),
                    "Oracle inventory replacement prior digest mismatch",
                )?;
                inventory.insert(game_id.clone(), game.inventory());
            }
            Mutation::Delete {
                game_id,
                expected_previous_digest,
            } => {
                ensure(
                    inventory
                        .get(game_id)
                        .is_some_and(|g| &g.digest == expected_previous_digest),
                    "Oracle inventory deletion prior digest mismatch",
                )?;
                inventory.remove(game_id);
            }
        }
    }
    let mut values = inventory.values().cloned().collect::<Vec<_>>();
    values.sort_by(validate::game_order);
    *current_digest =
        validate::source_digest(&next.name, &next.importer, &next.header_digest, &values);
    Ok(Delta {
        artifact_kind: DELTA_KIND.into(),
        schema_version: 1,
        importer_version: next.importer.clone(),
        source_file_name: next.name.clone(),
        header: next.header.clone(),
        header_digest: next.header_digest.clone(),
        partition: Partition {
            utc_date: partition.0,
            league: partition.1,
        },
        previous_oracle_digest: previous_digest,
        next_oracle_digest: current_digest.clone(),
        mutations,
    })
}

pub fn apply_delta(source: &mut Source, value: serde_json::Value) -> Result<()> {
    let mut delta: Delta = serde_json::from_value(value)?;
    ensure(
        delta.artifact_kind == DELTA_KIND && delta.schema_version == 1,
        "Unsupported Oracle delta",
    )?;
    ensure(
        delta.importer_version == source.importer
            && delta.source_file_name == source.name
            && delta.header_digest == source.header_digest,
        "Oracle delta compatibility mismatch",
    )?;
    let positions = indexes(&delta.header)?;
    ensure(
        digest(&serde_json::to_value(&delta.header)?) == delta.header_digest,
        "Oracle delta header digest mismatch",
    )?;
    validate::date(&delta.partition.utc_date)?;
    validate::nonempty(&delta.partition.league, "partition league")?;
    validate::sha(&delta.previous_oracle_digest)?;
    validate::sha(&delta.next_oracle_digest)?;
    ensure(
        delta.previous_oracle_digest == source.digest && !delta.mutations.is_empty(),
        "Oracle delta chain mismatch/empty mutations",
    )?;
    let mut seen = HashSet::new();
    for mutation in &mut delta.mutations {
        ensure(
            seen.insert(mutation.game_id().to_owned()),
            "Duplicate Oracle mutation",
        )?;
        validate::nonempty(mutation.game_id(), "mutation gameId")?;
        match mutation {
            Mutation::Add { game_id, game } | Mutation::Replace { game_id, game, .. } => {
                validate_game(game, &delta.header, positions)?;
                ensure(
                    game.game_id == *game_id
                        && game.date == delta.partition.utc_date
                        && game.league == delta.partition.league,
                    "Oracle mutation partition mismatch",
                )?;
            }
            _ => {}
        }
        match mutation {
            Mutation::Replace {
                expected_previous_digest,
                ..
            }
            | Mutation::Delete {
                expected_previous_digest,
                ..
            } => validate::sha(expected_previous_digest)?,
            _ => {}
        }
    }
    ensure(
        delta
            .mutations
            .windows(2)
            .all(|p| compare_code_units(p[0].game_id(), p[1].game_id()).is_le()),
        "Unsorted Oracle mutations",
    )?;
    let mut by_id = std::mem::take(&mut source.games)
        .into_iter()
        .map(|g| (g.game_id.clone(), g))
        .collect::<HashMap<_, _>>();
    for mutation in delta.mutations {
        match mutation {
            Mutation::Add { game_id, game } => {
                ensure(!by_id.contains_key(&game_id), "Oracle add already exists")?;
                by_id.insert(game_id, game);
            }
            Mutation::Replace {
                game_id,
                expected_previous_digest,
                game,
            } => {
                ensure(
                    by_id
                        .get(&game_id)
                        .is_some_and(|g| g.digest == expected_previous_digest),
                    "Oracle replacement digest mismatch",
                )?;
                by_id.insert(game_id, game);
            }
            Mutation::Delete {
                game_id,
                expected_previous_digest,
            } => {
                ensure(
                    by_id
                        .get(&game_id)
                        .is_some_and(|g| g.digest == expected_previous_digest),
                    "Oracle deletion digest mismatch",
                )?;
                by_id.remove(&game_id);
            }
        }
    }
    source.games = by_id.into_values().collect();
    source.games.sort_by(order);
    source.digest = validate::source_digest(
        &source.name,
        &source.importer,
        &source.header_digest,
        &source.inventory(),
    );
    ensure(
        source.digest == delta.next_oracle_digest,
        "Oracle delta next digest mismatch",
    )
}

pub fn csv(source: &Source) -> String {
    let mut output = String::new();
    for row in std::iter::once(&source.header).chain(source.games.iter().flat_map(|g| &g.rows)) {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            if value.contains([',', '"', '\r', '\n']) {
                output.push('"');
                output.push_str(&value.replace('"', "\"\""));
                output.push('"');
            } else {
                output.push_str(value);
            }
        }
        output.push('\n');
    }
    output
}

// Preserve the Node CSV grammar, including quote toggles in unquoted fields.
// Yield rows as they are read instead of retaining a second complete row list.
struct CsvRows<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
    done: bool,
}
impl<'a> CsvRows<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            chars: text.chars().peekable(),
            done: false,
        }
    }
}
impl Iterator for CsvRows<'_> {
    type Item = Result<Vec<String>>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        let mut row = Vec::new();
        let mut field = String::new();
        let mut quoted = false;
        while let Some(c) = self.chars.next() {
            match c {
                '"' if quoted && self.chars.peek() == Some(&'"') => {
                    field.push('"');
                    self.chars.next();
                }
                '"' => quoted = !quoted,
                ',' if !quoted => row.push(std::mem::take(&mut field)),
                '\n' | '\r' if !quoted => {
                    if c == '\r' && self.chars.peek() == Some(&'\n') {
                        self.chars.next();
                    }
                    row.push(field);
                    return Some(Ok(row));
                }
                _ => field.push(c),
            }
        }
        self.done = true;
        if quoted {
            return Some(Err("Unterminated Oracle quoted field".into()));
        }
        if !field.is_empty() || !row.is_empty() {
            row.push(field);
            Some(Ok(row))
        } else {
            None
        }
    }
}
