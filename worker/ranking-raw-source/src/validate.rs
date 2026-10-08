use crate::{Result, digest, ensure, types::*};
use ranking_contracts::{compare_code_units, provider_datetime_utc};
use serde_json::json;
use std::collections::HashSet;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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
pub fn inventory(value: &[InventoryGame]) -> Result<()> {
    ensure(!value.is_empty(), "Oracle inventory must be non-empty")?;
    let mut ids = HashSet::new();
    let mut orders = HashSet::new();
    for game in value {
        nonempty(&game.game_id, "gameId")?;
        date(&game.date)?;
        nonempty(&game.league, "league")?;
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
pub fn game_order(left: &InventoryGame, right: &InventoryGame) -> std::cmp::Ordering {
    left.source_order
        .cmp(&right.source_order)
        .then_with(|| compare_code_units(&left.game_id, &right.game_id))
}
pub fn source_digest(name: &str, importer: &str, header: &str, games: &[InventoryGame]) -> String {
    digest(
        &json!({"digestScheme":INVENTORY_SCHEME,"sourceFileName":name,"importerVersion":importer,"headerDigest":header,"gameInventory":games}),
    )
}
pub fn receipt(value: &mut Receipt) -> Result<()> {
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
    nonempty(&value.importer_version, "importerVersion")?;
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
        filename(&source.source_file_name)?;
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
            source_digest(
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
    value
        .oracle
        .sort_by(|a, b| compare_code_units(&a.source_file_name, &b.source_file_name));
    for entries in [&mut value.leaguepedia, &mut value.lolesports] {
        let mut names = HashSet::new();
        for source in entries.iter() {
            filename(&source.source_file_name)?;
            ensure(
                names.insert(&source.source_file_name),
                "Duplicate narrow source",
            )?;
            sha(&source.content_sha256)?;
            reference(&source.object)?;
        }
        entries.sort_by(|a, b| compare_code_units(&a.source_file_name, &b.source_file_name));
    }
    let identity = identity_digest(value);
    ensure(
        identity == value.raw_identity_digest,
        "Raw identity digest mismatch",
    )?;
    ensure(
        digest(
            &json!({"rawIdentityDigest":identity,"sourceReceiptInputs":value.source_receipt_inputs}),
        ) == value.source_receipt_digest,
        "Source receipt digest mismatch",
    )
}
pub fn identity_digest(value: &Receipt) -> String {
    digest(
        &json!({"importerVersion":value.importer_version,"coverage":value.coverage,"oracle":value.oracle,"leaguepedia":value.leaguepedia,"lolesports":value.lolesports}),
    )
}
