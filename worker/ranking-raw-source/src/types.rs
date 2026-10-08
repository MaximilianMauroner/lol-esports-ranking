use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STORAGE_MODE: &str = "content-addressed-raw-gzip-v2";
pub const INVENTORY_SCHEME: &str = "oracle-game-inventory-v1";
pub const RECEIPT_KIND: &str = "raw-source-generation-receipt";
pub const BASELINE_KIND: &str = "oracle-complete-game-baseline";
pub const DELTA_KIND: &str = "oracle-date-league-delta";
pub const NARROW_KIND: &str = "raw-narrow-provider-file";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub key: String,
    pub sha256: String,
    pub bytes: u64,
    pub storage_encoding: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_transport_size"
    )]
    pub compressed_bytes: Option<u64>,
}

fn optional_transport_size<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u64>, D::Error> {
    // An omitted legacy field is valid; an explicitly null field is not.
    u64::deserialize(deserializer).map(Some)
}

fn optional_importer_version<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Coverage {
    pub start: String,
    pub end: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryGame {
    pub game_id: String,
    pub digest: String,
    pub date: String,
    pub league: String,
    pub source_order: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub game_id: String,
    pub date: String,
    pub league: String,
    pub source_order: u64,
    pub rows: Vec<Vec<String>>,
    #[serde(default)]
    pub digest: String,
}

impl Game {
    pub fn inventory(&self) -> InventoryGame {
        InventoryGame {
            game_id: self.game_id.clone(),
            digest: self.digest.clone(),
            date: self.date.clone(),
            league: self.league.clone(),
            source_order: self.source_order,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleReceipt {
    pub source_file_name: String,
    pub header_digest: String,
    pub digest_scheme: String,
    pub effective_oracle_digest: String,
    pub game_inventory: Vec<InventoryGame>,
    pub baseline: Reference,
    pub deltas: Vec<Reference>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NarrowReceipt {
    pub source_file_name: String,
    pub content_sha256: String,
    pub object: Reference,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub artifact_kind: String,
    pub schema_version: u32,
    pub storage_mode: String,
    pub generation_id: String,
    pub importer_version: String,
    pub coverage: Coverage,
    pub raw_identity_digest: String,
    pub source_receipt_inputs: Value,
    pub source_receipt_digest: String,
    pub oracle: Vec<OracleReceipt>,
    pub leaguepedia: Vec<NarrowReceipt>,
    pub lolesports: Vec<NarrowReceipt>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Baseline {
    pub artifact_kind: String,
    pub schema_version: u32,
    pub importer_version: String,
    pub source_file_name: String,
    pub header: Vec<String>,
    pub header_digest: String,
    pub oracle_digest: String,
    pub games: Vec<Game>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Partition {
    pub utc_date: String,
    pub league: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
pub enum Mutation {
    Add {
        #[serde(rename = "gameId")]
        game_id: String,
        game: Game,
    },
    Replace {
        #[serde(rename = "gameId")]
        game_id: String,
        #[serde(rename = "expectedPreviousDigest")]
        expected_previous_digest: String,
        game: Game,
    },
    Delete {
        #[serde(rename = "gameId")]
        game_id: String,
        #[serde(rename = "expectedPreviousDigest")]
        expected_previous_digest: String,
    },
}

impl Mutation {
    pub fn game_id(&self) -> &str {
        match self {
            Self::Add { game_id, .. }
            | Self::Replace { game_id, .. }
            | Self::Delete { game_id, .. } => game_id,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delta {
    pub artifact_kind: String,
    pub schema_version: u32,
    pub importer_version: String,
    pub source_file_name: String,
    pub header: Vec<String>,
    pub header_digest: String,
    pub partition: Partition,
    pub previous_oracle_digest: String,
    pub next_oracle_digest: String,
    pub mutations: Vec<Mutation>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Narrow {
    pub artifact_kind: String,
    pub schema_version: u32,
    pub provider: String,
    pub importer_version: String,
    pub source_file_name: String,
    pub content_sha256: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum Input {
    Prepare {
        #[serde(rename = "objectDir")]
        object_dir: String,
        #[serde(rename = "manifestPath")]
        manifest_path: String,
        #[serde(rename = "rawDir")]
        raw_dir: String,
        #[serde(rename = "importerVersion")]
        importer_version: String,
        #[serde(rename = "generatedAt")]
        generated_at: String,
        #[serde(rename = "previousReceipt")]
        previous_receipt: Option<Receipt>,
    },
    Restore {
        receipt: Receipt,
        #[serde(rename = "receiptReference")]
        receipt_reference: Reference,
        #[serde(
            rename = "importerVersion",
            default,
            deserialize_with = "optional_importer_version"
        )]
        importer_version: Option<String>,
        #[serde(rename = "requiredCoverage")]
        required_coverage: Option<Coverage>,
        #[serde(rename = "objectFiles", default)]
        object_files: std::collections::BTreeMap<String, String>,
        #[serde(rename = "destinationDir")]
        destination_dir: String,
        #[serde(rename = "generatedAt")]
        generated_at: String,
    },
}
