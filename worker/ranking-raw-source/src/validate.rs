use crate::{Result, ensure, types::*};
use ranking_contracts::{
    Utf16Json, Utf16String, canonical_json_value, provider_datetime_utc, sha256,
};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, fmt::Write, hash::Hash};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub trait ReceiptText: Eq + Hash {
    fn code_units(&self) -> impl Iterator<Item = u16>;
    fn write_json(&self, output: &mut String);
}

impl ReceiptText for str {
    fn code_units(&self) -> impl Iterator<Item = u16> {
        self.encode_utf16()
    }
    fn write_json(&self, output: &mut String) {
        write_string(output, self);
    }
}

impl ReceiptText for String {
    fn code_units(&self) -> impl Iterator<Item = u16> {
        self.encode_utf16()
    }
    fn write_json(&self, output: &mut String) {
        write_string(output, self);
    }
}

impl ReceiptText for Utf16String {
    fn code_units(&self) -> impl Iterator<Item = u16> {
        self.code_units()
    }
    fn write_json(&self, output: &mut String) {
        self.write_json(output);
    }
}

pub trait ReceiptInputs {
    fn is_object(&self) -> bool;
    fn write_json(&self, output: &mut String);
}

impl ReceiptInputs for Value {
    fn is_object(&self) -> bool {
        self.is_object()
    }
    fn write_json(&self, output: &mut String) {
        output.push_str(&canonical_json_value(self));
    }
}

impl ReceiptInputs for Utf16Json {
    fn is_object(&self) -> bool {
        self.is_object()
    }
    fn write_json(&self, output: &mut String) {
        self.write_canonical(output);
    }
}

fn receipt_nonempty(value: &impl ReceiptText, label: &str) -> Result<()> {
    ensure(
        value.code_units().next().is_some(),
        format!("{label} must be non-empty"),
    )
}

fn receipt_filename(value: &impl ReceiptText) -> Result<()> {
    let units = || value.code_units();
    ensure(
        units().next().is_some()
            && !units().any(|unit| unit == u16::from(b'/'))
            && !units().eq([u16::from(b'.')])
            && !units().eq([u16::from(b'.'); 2]),
        "Invalid raw filename",
    )
}

pub fn trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(
            c,
            '\t' | '\n'
                | '\u{000b}'
                | '\u{000c}'
                | '\r'
                | ' '
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

pub fn nonempty(value: &str, label: &str) -> Result<()> {
    ensure(!value.is_empty(), format!("{label} must be non-empty"))
}
pub fn filename(value: &str) -> Result<()> {
    ensure(
        !value.is_empty() && !value.contains('/') && value != "." && value != "..",
        "Invalid raw filename",
    )
}
pub fn sha(value: &str) -> Result<()> {
    ensure(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid SHA-256 digest",
    )
}
pub fn date(value: &str) -> Result<()> {
    ensure(
        value.len() == 10
            && value.bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            }),
        "Invalid UTC date",
    )?;
    let normalized = provider_datetime_utc(value);
    ensure(
        normalized.as_deref().map(|v| &v[..10]) == Some(value),
        "Invalid UTC date",
    )
}
pub fn coverage(value: &Coverage) -> Result<()> {
    date(&value.start)?;
    date(&value.end)?;
    ensure(value.start <= value.end, "Reversed coverage")
}
pub fn reference(value: &Reference) -> Result<()> {
    sha(&value.sha256)?;
    ensure(
        value.key == format!("raw/objects/sha256/{}", value.sha256),
        "Non-canonical raw object key",
    )?;
    ensure(
        value.storage_encoding == "gzip",
        "Invalid raw object encoding",
    )?;
    ensure(
        value.bytes > 0 && value.bytes <= MAX_SAFE_INTEGER,
        "Invalid raw semantic size",
    )?;
    if let Some(bytes) = value.compressed_bytes {
        ensure(
            bytes > 0 && bytes <= MAX_SAFE_INTEGER,
            "Invalid legacy raw transport size",
        )?;
    }
    Ok(())
}
pub fn header(value: &[String]) -> Result<()> {
    ensure(!value.is_empty(), "Oracle header is empty")?;
    let mut seen = HashSet::new();
    for field in value {
        ensure(
            seen.insert(trim(field).to_lowercase()),
            "Duplicate Oracle header field",
        )?;
    }
    Ok(())
}
pub fn inventory<S: ReceiptText>(value: &[InventoryGame<S>]) -> Result<()> {
    ensure(!value.is_empty(), "Oracle inventory must be non-empty")?;
    let mut ids = HashSet::new();
    let mut orders = HashSet::new();
    for game in value {
        receipt_nonempty(&game.game_id, "gameId")?;
        date(&game.date)?;
        receipt_nonempty(&game.league, "league")?;
        sha(&game.digest)?;
        ensure(
            game.source_order <= MAX_SAFE_INTEGER,
            "Invalid source order",
        )?;
        ensure(
            ids.insert(&game.game_id) && orders.insert(game.source_order),
            "Duplicate inventory identity/order",
        )?;
    }
    ensure(
        value
            .windows(2)
            .all(|pair| game_order(&pair[0], &pair[1]).is_le()),
        "Unsorted Oracle inventory",
    )
}
pub fn game_order<S: ReceiptText>(
    left: &InventoryGame<S>,
    right: &InventoryGame<S>,
) -> std::cmp::Ordering {
    left.source_order
        .cmp(&right.source_order)
        .then_with(|| left.game_id.code_units().cmp(right.game_id.code_units()))
}
pub fn source_digest(name: &str, importer: &str, header: &str, games: &[InventoryGame]) -> String {
    inventory_digest(name, importer, header, games)
}

fn inventory_digest<S: ReceiptText, N: ReceiptText + ?Sized, I: ReceiptText + ?Sized>(
    name: &N,
    importer: &I,
    header: &str,
    games: &[InventoryGame<S>],
) -> String {
    let mut identity = String::from("{\"digestScheme\":");
    write_string(&mut identity, INVENTORY_SCHEME);
    identity.push_str(",\"gameInventory\":");
    write_inventory(&mut identity, games);
    identity.push_str(",\"headerDigest\":");
    write_string(&mut identity, header);
    identity.push_str(",\"importerVersion\":");
    importer.write_json(&mut identity);
    identity.push_str(",\"sourceFileName\":");
    name.write_json(&mut identity);
    identity.push('}');
    sha256(identity.as_bytes())
}

pub fn receipt<S: ReceiptText, V: ReceiptInputs>(value: &mut Receipt<S, V>) -> Result<()> {
    ensure(
        value.artifact_kind == RECEIPT_KIND
            && value.schema_version == 1
            && value.storage_mode == STORAGE_MODE,
        "Unsupported raw receipt",
    )?;
    ensure(
        !value.generation_id.is_empty()
            && value.generation_id.len() <= 200
            && value
                .generation_id
                .bytes()
                .enumerate()
                .all(|(i, b)| b.is_ascii_alphanumeric() || (i > 0 && b"._:-".contains(&b))),
        "Invalid generation id",
    )?;
    receipt_nonempty(&value.importer_version, "importerVersion")?;
    coverage(&value.coverage)?;
    sha(&value.raw_identity_digest)?;
    sha(&value.source_receipt_digest)?;
    ensure(
        value.source_receipt_inputs.is_object(),
        "Invalid sourceReceiptInputs",
    )?;
    ensure(!value.oracle.is_empty(), "Raw receipt has no Oracle source")?;
    let mut names = HashSet::new();
    for source in &value.oracle {
        receipt_filename(&source.source_file_name)?;
        ensure(
            names.insert(&source.source_file_name),
            "Duplicate Oracle source",
        )?;
        sha(&source.header_digest)?;
        sha(&source.effective_oracle_digest)?;
        ensure(
            source.digest_scheme == INVENTORY_SCHEME,
            "Invalid inventory scheme",
        )?;
        inventory(&source.game_inventory)?;
        ensure(
            inventory_digest(
                &source.source_file_name,
                &value.importer_version,
                &source.header_digest,
                &source.game_inventory,
            ) == source.effective_oracle_digest,
            "Oracle inventory digest mismatch",
        )?;
        reference(&source.baseline)?;
        let mut keys = HashSet::from([&source.baseline.key]);
        for delta in &source.deltas {
            reference(delta)?;
            ensure(keys.insert(&delta.key), "Duplicate Oracle object reference")?;
        }
    }
    value.oracle.sort_by(|a, b| {
        a.source_file_name
            .code_units()
            .cmp(b.source_file_name.code_units())
    });
    for entries in [&mut value.leaguepedia, &mut value.lolesports] {
        let mut names = HashSet::new();
        for source in entries.iter() {
            receipt_filename(&source.source_file_name)?;
            ensure(
                names.insert(&source.source_file_name),
                "Duplicate narrow source",
            )?;
            sha(&source.content_sha256)?;
            reference(&source.object)?;
        }
        entries.sort_by(|a, b| {
            a.source_file_name
                .code_units()
                .cmp(b.source_file_name.code_units())
        });
    }
    let identity = sha256(identity_json(value).as_bytes());
    ensure(
        identity == value.raw_identity_digest,
        "Raw identity digest mismatch",
    )?;
    ensure(
        source_receipt_digest(&identity, &value.source_receipt_inputs)
            == value.source_receipt_digest,
        "Source receipt digest mismatch",
    )
}
pub fn identity_digest(value: &Receipt) -> String {
    sha256(identity_json(value).as_bytes())
}

fn write_string(output: &mut String, value: &str) {
    output.push_str(&serde_json::to_string(value).expect("JSON string is serializable"));
}

fn write_serializable(output: &mut String, value: &impl Serialize) {
    let value = serde_json::to_value(value).expect("Raw reference/coverage is serializable");
    output.push_str(&canonical_json_value(&value));
}

// The receipt schema has fixed ASCII keys. Write them in canonical order from
// borrowed fields, so default prepare/restore never clones an inventory tree.
fn write_inventory<S: ReceiptText>(output: &mut String, games: &[InventoryGame<S>]) {
    output.push('[');
    for (index, game) in games.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str("{\"date\":");
        write_string(output, &game.date);
        output.push_str(",\"digest\":");
        write_string(output, &game.digest);
        output.push_str(",\"gameId\":");
        game.game_id.write_json(output);
        output.push_str(",\"league\":");
        game.league.write_json(output);
        output.push_str(",\"sourceOrder\":");
        write!(output, "{}", game.source_order).unwrap();
        output.push('}');
    }
    output.push(']');
}

fn write_oracle<S: ReceiptText>(output: &mut String, sources: &[OracleReceipt<S>]) {
    output.push('[');
    for (index, source) in sources.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str("{\"baseline\":");
        write_serializable(output, &source.baseline);
        output.push_str(",\"deltas\":");
        write_serializable(output, &source.deltas);
        output.push_str(",\"digestScheme\":");
        write_string(output, &source.digest_scheme);
        output.push_str(",\"effectiveOracleDigest\":");
        write_string(output, &source.effective_oracle_digest);
        output.push_str(",\"gameInventory\":");
        write_inventory(output, &source.game_inventory);
        output.push_str(",\"headerDigest\":");
        write_string(output, &source.header_digest);
        output.push_str(",\"sourceFileName\":");
        source.source_file_name.write_json(output);
        output.push('}');
    }
    output.push(']');
}

fn write_narrow<S: ReceiptText>(output: &mut String, sources: &[NarrowReceipt<S>]) {
    output.push('[');
    for (index, source) in sources.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str("{\"contentSha256\":");
        write_string(output, &source.content_sha256);
        output.push_str(",\"object\":");
        write_serializable(output, &source.object);
        output.push_str(",\"sourceFileName\":");
        source.source_file_name.write_json(output);
        output.push('}');
    }
    output.push(']');
}

fn identity_json<S: ReceiptText, V>(value: &Receipt<S, V>) -> String {
    let mut output = String::from("{\"coverage\":");
    write_serializable(&mut output, &value.coverage);
    output.push_str(",\"importerVersion\":");
    value.importer_version.write_json(&mut output);
    output.push_str(",\"leaguepedia\":");
    write_narrow(&mut output, &value.leaguepedia);
    output.push_str(",\"lolesports\":");
    write_narrow(&mut output, &value.lolesports);
    output.push_str(",\"oracle\":");
    write_oracle(&mut output, &value.oracle);
    output.push('}');
    output
}

fn source_receipt_digest<V: ReceiptInputs>(identity: &str, inputs: &V) -> String {
    let mut output = String::from("{\"rawIdentityDigest\":");
    write_string(&mut output, identity);
    output.push_str(",\"sourceReceiptInputs\":");
    inputs.write_json(&mut output);
    output.push('}');
    sha256(output.as_bytes())
}

pub fn receipt_json<S: ReceiptText, V: ReceiptInputs>(value: &Receipt<S, V>) -> String {
    let mut output = String::from("{\"artifactKind\":");
    write_string(&mut output, &value.artifact_kind);
    output.push_str(",\"coverage\":");
    write_serializable(&mut output, &value.coverage);
    output.push_str(",\"generationId\":");
    write_string(&mut output, &value.generation_id);
    output.push_str(",\"importerVersion\":");
    value.importer_version.write_json(&mut output);
    output.push_str(",\"leaguepedia\":");
    write_narrow(&mut output, &value.leaguepedia);
    output.push_str(",\"lolesports\":");
    write_narrow(&mut output, &value.lolesports);
    output.push_str(",\"oracle\":");
    write_oracle(&mut output, &value.oracle);
    output.push_str(",\"rawIdentityDigest\":");
    write_string(&mut output, &value.raw_identity_digest);
    output.push_str(",\"schemaVersion\":");
    write!(output, "{}", value.schema_version).unwrap();
    output.push_str(",\"sourceReceiptDigest\":");
    write_string(&mut output, &value.source_receipt_digest);
    output.push_str(",\"sourceReceiptInputs\":");
    value.source_receipt_inputs.write_json(&mut output);
    output.push_str(",\"storageMode\":");
    write_string(&mut output, &value.storage_mode);
    output.push('}');
    output
}
