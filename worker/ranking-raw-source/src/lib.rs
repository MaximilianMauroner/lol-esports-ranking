mod fs;
mod oracle;
mod types;
mod validate;

use ranking_contracts::{canonical_json_value, gunzip, gzip, js_pretty_json_value, sha256};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use types::*;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn ensure(condition: bool, message: impl Into<String>) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into().into())
    }
}

fn digest(value: &Value) -> String {
    sha256(canonical_json_value(value).as_bytes())
}

/// Execute the existing file-descriptor seam without Node or provider access.
pub fn run(input_path: &str, output_path: &str) -> Result<()> {
    let input: Input = serde_json::from_slice(&std::fs::read(fs::absolute(input_path)?)?)?;
    let mut output = match input {
        Input::Prepare {
            object_dir,
            manifest_path,
            raw_dir,
            importer_version,
            generated_at,
            previous_receipt,
        } => prepare(
            &object_dir,
            &manifest_path,
            &raw_dir,
            &importer_version,
            &generated_at,
            previous_receipt,
        )?,
        Input::Restore {
            receipt,
            receipt_reference,
            importer_version,
            required_coverage,
            object_files,
            destination_dir,
            generated_at,
        } => restore(
            receipt,
            receipt_reference,
            importer_version.as_deref(),
            required_coverage,
            &object_files,
            &destination_dir,
            &generated_at,
        )?,
    };
    output["childMaxRssBytes"] = json!(fs::peak_rss()?);
    let output_path = fs::absolute(output_path)?;
    std::fs::create_dir_all(output_path.parent().ok_or("Output has no parent")?)?;
    let temporary = PathBuf::from(format!(
        "{}.{}.tmp",
        output_path.display(),
        std::process::id()
    ));
    let result = (|| -> Result<()> {
        fs::write_new(
            &temporary,
            format!("{}\n", serde_json::to_string(&output)?).as_bytes(),
        )?;
        std::fs::rename(&temporary, &output_path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

struct ObjectStore {
    directory: PathBuf,
    objects: Vec<Value>,
    seen: HashSet<String>,
}
impl ObjectStore {
    fn store(&mut self, value: &Value) -> Result<Reference> {
        let canonical = canonical_json_value(value);
        let digest = sha256(canonical.as_bytes());
        let bytes = canonical.len() as u64;
        if self.seen.insert(digest.clone()) {
            let compressed = gzip(canonical.as_bytes())?;
            let path = self.directory.join(&digest);
            fs::write_new(&path, &compressed)?;
            self.objects.push(json!({"digest":digest,"bytes":bytes,"compressedBytes":compressed.len(),"compressedPath":path,"compressedSha256":sha256(&compressed)}));
        }
        Ok(Reference {
            key: format!("raw/objects/sha256/{digest}"),
            sha256: digest,
            bytes,
            storage_encoding: "gzip".into(),
            compressed_bytes: None,
        })
    }
}

struct VerifiedFile {
    provider: &'static str,
    name: String,
    path: PathBuf,
    hash: String,
}

fn paths(manifest: &Value, group: &str, raw_dir: &Path) -> Result<Vec<PathBuf>> {
    let Some(entries) = manifest["files"][group].as_array() else {
        return Ok(Vec::new());
    };
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for entry in entries {
        let path = fs::manifest_path(
            entry
                .as_str()
                .ok_or("Manifest file path must be a string")?,
            raw_dir,
        )?;
        if seen.insert(path.clone()) {
            output.push(path);
        }
    }
    Ok(output)
}

fn source_inputs(manifest: &Value) -> Value {
    let mut values = serde_json::Map::new();
    for key in ["generatedAt", "refreshWindow"] {
        if let Some(value) = manifest.get(key) {
            values.insert(key.into(), value.clone());
        }
    }
    values.insert(
        "sources".into(),
        manifest
            .get("sources")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!({})),
    );
    values.insert(
        "warnings".into(),
        manifest
            .get("warnings")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!([])),
    );
    for key in ["sourceAuthorityEvidence", "refreshAttempt"] {
        if let Some(value) = manifest.get(key).filter(|v| truthy(v)) {
            values.insert(key.into(), value.clone());
        }
    }
    Value::Object(values)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64() != Some(0.0),
        _ => true,
    }
}

fn prepare(
    object_dir: &str,
    manifest_path: &str,
    raw_dir: &str,
    importer: &str,
    generated_at: &str,
    mut previous: Option<Receipt>,
) -> Result<Value> {
    let started = Instant::now();
    let directory = fs::absolute(object_dir)?;
    fs::remove_dir(&directory)?;
    let result = (|| -> Result<Value> {
        validate::nonempty(importer, "importerVersion")?;
        validate::nonempty(generated_at, "generatedAt")?;
        if let Some(receipt) = &mut previous {
            validate::receipt(receipt)?;
        }
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(fs::absolute(manifest_path)?)?)?;
        let raw_dir = fs::absolute(raw_dir)?;
        let coverage = Coverage {
            start: manifest["start"]
                .as_str()
                .ok_or("Missing coverage start")?
                .into(),
            end: manifest["end"]
                .as_str()
                .ok_or("Missing coverage end")?
                .into(),
        };
        validate::coverage(&coverage)?;
        std::fs::create_dir_all(&directory)?;
        let mut store = ObjectStore {
            directory: directory.clone(),
            objects: Vec::new(),
            seen: HashSet::new(),
        };
        let mut oracle = Vec::new();
        let mut verified = Vec::new();
        for path in paths(&manifest, "oracleCsv", &raw_dir)? {
            let name = path
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("Invalid Oracle filename")?;
            let bytes = std::fs::read(&path)?;
            let text = String::from_utf8_lossy(&bytes);
            let source = oracle::parse_csv(&text, name, importer)?;
            let prior = previous
                .as_ref()
                .and_then(|r| r.oracle.iter().find(|r| r.source_file_name == name));
            let (baseline, deltas) = if let Some(prior) = prior {
                let chain = oracle::mutation_chain(prior, &source)?;
                if prior.deltas.len() + chain.len() > 32 {
                    (store.store(&source.baseline())?, Vec::new())
                } else {
                    let mut references = prior.deltas.clone();
                    for delta in chain {
                        references.push(store.store(&serde_json::to_value(delta)?)?);
                    }
                    (prior.baseline.clone(), references)
                }
            } else {
                (store.store(&source.baseline())?, Vec::new())
            };
            oracle.push(OracleReceipt {
                source_file_name: name.into(),
                header_digest: source.header_digest.clone(),
                digest_scheme: INVENTORY_SCHEME.into(),
                effective_oracle_digest: source.digest.clone(),
                game_inventory: source.inventory(),
                baseline,
                deltas,
            });
            verified.push(VerifiedFile {
                provider: "oracle",
                name: name.into(),
                path: path.clone(),
                hash: sha256(text.as_bytes()),
            });
        }
        let mut narrow_groups = Vec::new();
        for (provider, group) in [
            ("leaguepedia", "leaguepediaJson"),
            ("lolesports", "lolEsportsJson"),
        ] {
            let mut entries = Vec::new();
            for path in paths(&manifest, group, &raw_dir)? {
                let name = path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .ok_or("Invalid narrow filename")?;
                validate::filename(name)?;
                let content = String::from_utf8_lossy(&std::fs::read(&path)?).into_owned();
                let hash = sha256(content.as_bytes());
                let object = store.store(&json!({"artifactKind":NARROW_KIND,"schemaVersion":1,"provider":provider,"importerVersion":importer,"sourceFileName":name,"contentSha256":hash,"content":content}))?;
                entries.push(NarrowReceipt {
                    source_file_name: name.into(),
                    content_sha256: hash.clone(),
                    object,
                });
                verified.push(VerifiedFile {
                    provider,
                    name: name.into(),
                    path: path.clone(),
                    hash,
                });
            }
            narrow_groups.push(entries);
        }
        let lolesports = narrow_groups.pop().expect("two provider groups");
        let leaguepedia = narrow_groups.pop().expect("two provider groups");
        let inputs = source_inputs(&manifest);
        let mut receipt = Receipt {
            artifact_kind: RECEIPT_KIND.into(),
            schema_version: 1,
            storage_mode: STORAGE_MODE.into(),
            generation_id: "pending_raw_generation".into(),
            importer_version: importer.into(),
            coverage: coverage.clone(),
            raw_identity_digest: String::new(),
            source_receipt_inputs: inputs.clone(),
            source_receipt_digest: String::new(),
            oracle: oracle.clone(),
            leaguepedia: leaguepedia.clone(),
            lolesports: lolesports.clone(),
        };
        receipt.oracle.sort_by(|a, b| {
            ranking_contracts::compare_code_units(&a.source_file_name, &b.source_file_name)
        });
        for source in &mut receipt.oracle {
            source.baseline.compressed_bytes = None;
            for delta in &mut source.deltas {
                delta.compressed_bytes = None;
            }
        }
        for entries in [&mut receipt.leaguepedia, &mut receipt.lolesports] {
            entries.sort_by(|a, b| {
                ranking_contracts::compare_code_units(&a.source_file_name, &b.source_file_name)
            });
            for entry in entries {
                entry.object.compressed_bytes = None;
            }
        }
        receipt.raw_identity_digest = validate::identity_digest(&receipt);
        receipt.source_receipt_digest = digest(
            &json!({"rawIdentityDigest":receipt.raw_identity_digest,"sourceReceiptInputs":inputs}),
        );
        validate::receipt(&mut receipt)?;
        let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        let materialize_start = Instant::now();
        let manifest_path = materialize_verified(&receipt, &verified, &raw_dir, generated_at)?;
        let materialize_ms = materialize_start.elapsed().as_secs_f64() * 1000.0;
        Ok(
            json!({"action":"prepare","manifestPath":manifest_path,"prepareMs":prepare_ms,"materializeMs":materialize_ms,"totalMs":started.elapsed().as_secs_f64()*1000.0,
            "generation":{"generationId":receipt.generation_id,"importerVersion":importer,"coverage":coverage,"sourceReceiptInputs":inputs,"oracle":oracle,"leaguepedia":leaguepedia,"lolesports":lolesports,"objects":store.objects,"receipt":receipt,"sourceReceiptDigest":receipt.source_receipt_digest,"rawIdentityDigest":receipt.raw_identity_digest}}),
        )
    })();
    if result.is_err() {
        fs::remove_dir(&directory)?;
    }
    result
}

fn staging_dir(destination: &Path) -> Result<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let next = PathBuf::from(format!(
        "{}.receipt-next-{}-{stamp}",
        destination.display(),
        std::process::id()
    ));
    fs::remove_dir(&next)?;
    std::fs::create_dir_all(&next)?;
    Ok(next)
}

fn materialized_manifest(
    receipt: &Receipt,
    generated_at: &str,
    files: Value,
    restored: bool,
) -> Value {
    let mut manifest = json!({"schemaVersion":1,"generatedAt":generated_at,"start":receipt.coverage.start,"end":receipt.coverage.end,"files":files,
        "sourceReceipt":{"storageMode":STORAGE_MODE,"generationId":receipt.generation_id,"rawIdentityDigest":receipt.raw_identity_digest,"sourceReceiptDigest":receipt.source_receipt_digest},
        "sources":receipt.source_receipt_inputs.get("sources").cloned().unwrap_or(json!({})),"warnings":receipt.source_receipt_inputs.get("warnings").cloned().unwrap_or(json!([]))});
    if restored {
        let status = |count: usize, role: &str| json!({"role":role,"status":if count>0 {"downloaded"} else {"skipped"},"downloadedCount":count,"reusedCount":0,"failedCount":0});
        manifest["sources"] = json!({"oracle":status(receipt.oracle.len(),"primary"),"leaguepedia":status(receipt.leaguepedia.len(),"backup-gap-fill"),"lolesports":status(receipt.lolesports.len(),"schedule-results-reference")});
        manifest["warnings"] = json!([]);
    } else {
        for key in ["refreshWindow", "sourceAuthorityEvidence", "refreshAttempt"] {
            if let Some(value) = receipt.source_receipt_inputs.get(key).filter(|v| truthy(v)) {
                manifest[key] = value.clone();
            }
        }
    }
    manifest
}

fn materialize_verified(
    receipt: &Receipt,
    sources: &[VerifiedFile],
    destination: &Path,
    generated_at: &str,
) -> Result<PathBuf> {
    let next = staging_dir(destination)?;
    let result = (|| -> Result<PathBuf> {
        let mut files = json!({"oracleCsv":[],"leaguepediaJson":[],"lolEsportsJson":[]});
        for source in sources {
            let (directory, group) = provider_paths(source.provider);
            let relative = format!("{directory}/{}", source.name);
            std::fs::create_dir_all(next.join(directory))?;
            fs::copy_verified(&source.path, &next.join(&relative), &source.hash)?;
            files[group]
                .as_array_mut()
                .expect("file group is an array")
                .push(json!(relative));
        }
        let manifest = materialized_manifest(receipt, generated_at, files, false);
        fs::write_new(
            &next.join("manifest.json"),
            format!("{}\n", js_pretty_json_value(&manifest)).as_bytes(),
        )?;
        fs::replace_directory(&next, destination)?;
        Ok(destination.join("manifest.json"))
    })();
    if result.is_err() {
        fs::remove_dir(&next)?;
    }
    result
}

fn provider_paths(provider: &str) -> (&str, &str) {
    match provider {
        "oracle" => ("oracles-elixir", "oracleCsv"),
        "leaguepedia" => ("leaguepedia", "leaguepediaJson"),
        _ => ("lolesports", "lolEsportsJson"),
    }
}

fn read_object(reference: &Reference, objects: &BTreeMap<String, String>) -> Result<Value> {
    validate::reference(reference)?;
    let path = objects.get(&reference.key).ok_or("Missing raw object")?;
    let compressed = std::fs::read(path)?;
    if let Some(size) = reference.compressed_bytes {
        ensure(
            compressed.len() as u64 == size,
            "Legacy compressed length mismatch",
        )?;
    }
    let bytes = gunzip(&compressed)?;
    ensure(
        bytes.len() as u64 == reference.bytes && sha256(&bytes) == reference.sha256,
        "Raw semantic digest mismatch",
    )?;
    let value: Value = serde_json::from_slice(&bytes)?;
    ensure(
        canonical_json_value(&value).as_bytes() == bytes,
        "Raw object is not canonical JSON",
    )?;
    Ok(value)
}

fn restore(
    mut receipt: Receipt,
    reference: Reference,
    importer: Option<&str>,
    required: Option<Coverage>,
    objects: &BTreeMap<String, String>,
    destination: &str,
    generated_at: &str,
) -> Result<Value> {
    let started = Instant::now();
    validate::receipt(&mut receipt)?;
    validate::reference(&reference)?;
    let bytes = canonical_json_value(&serde_json::to_value(&receipt)?);
    ensure(
        sha256(bytes.as_bytes()) == reference.sha256 && bytes.len() as u64 == reference.bytes,
        "Raw receipt authority reference mismatch",
    )?;
    if let Some(importer) = importer {
        ensure(
            receipt.importer_version == importer,
            "Raw importer compatibility mismatch",
        )?;
    }
    if let Some(required) = required {
        validate::coverage(&required)?;
        ensure(
            receipt.coverage.start <= required.start && receipt.coverage.end >= required.end,
            "Raw coverage incompatible with recovery window",
        )?;
    }
    validate::nonempty(generated_at, "generatedAt")?;
    let expected = receipt
        .oracle
        .iter()
        .flat_map(|s| std::iter::once(&s.baseline).chain(&s.deltas))
        .chain(
            receipt
                .leaguepedia
                .iter()
                .chain(&receipt.lolesports)
                .map(|s| &s.object),
        )
        .map(|r| &r.key)
        .collect::<HashSet<_>>();
    ensure(
        expected.len() == objects.len() && objects.keys().all(|k| expected.contains(k)),
        "Raw restore object file set differs from receipt graph",
    )?;
    let destination = fs::absolute(destination)?;
    let next = staging_dir(&destination)?;
    let result = (|| -> Result<Value> {
        let mut files = json!({"oracleCsv":[],"leaguepediaJson":[],"lolEsportsJson":[]});
        for directory in ["oracles-elixir", "leaguepedia", "lolesports"] {
            std::fs::create_dir_all(next.join(directory))?;
        }
        for entry in &receipt.oracle {
            let mut source = oracle::parse_baseline(
                read_object(&entry.baseline, objects)?,
                &receipt.importer_version,
            )?;
            ensure(
                source.name == entry.source_file_name
                    && source.header_digest == entry.header_digest,
                "Oracle receipt compatibility mismatch",
            )?;
            for delta in &entry.deltas {
                oracle::apply_delta(&mut source, read_object(delta, objects)?)?;
            }
            ensure(
                source.digest == entry.effective_oracle_digest
                    && source.inventory() == entry.game_inventory,
                "Oracle receipt chain/inventory mismatch",
            )?;
            let relative = format!("oracles-elixir/{}", source.name);
            fs::write_new(&next.join(&relative), oracle::csv(&source).as_bytes())?;
            files["oracleCsv"]
                .as_array_mut()
                .expect("array")
                .push(json!(relative));
        }
        for (provider, entries) in [
            ("leaguepedia", &receipt.leaguepedia),
            ("lolesports", &receipt.lolesports),
        ] {
            let (_, group) = provider_paths(provider);
            for entry in entries {
                let object: Narrow = serde_json::from_value(read_object(&entry.object, objects)?)?;
                ensure(
                    object.artifact_kind == NARROW_KIND
                        && object.schema_version == 1
                        && object.provider == provider
                        && object.importer_version == receipt.importer_version
                        && object.source_file_name == entry.source_file_name
                        && object.content_sha256 == entry.content_sha256,
                    "Narrow receipt compatibility mismatch",
                )?;
                ensure(
                    sha256(object.content.as_bytes()) == object.content_sha256,
                    "Narrow content digest mismatch",
                )?;
                let relative = format!("{provider}/{}", object.source_file_name);
                fs::write_new(&next.join(&relative), object.content.as_bytes())?;
                files[group]
                    .as_array_mut()
                    .expect("array")
                    .push(json!(relative));
            }
        }
        let manifest = materialized_manifest(&receipt, generated_at, files, true);
        fs::write_new(
            &next.join("manifest.json"),
            format!("{}\n", js_pretty_json_value(&manifest)).as_bytes(),
        )?;
        fs::replace_directory(&next, &destination)?;
        let identity = json!({"generationId":receipt.generation_id,"importerVersion":receipt.importer_version,"coverage":receipt.coverage,"sourceReceiptDigest":receipt.source_receipt_digest,"rawIdentityDigest":receipt.raw_identity_digest,"receiptSchemaVersion":receipt.schema_version,"storageMode":receipt.storage_mode,"receiptReference":reference});
        Ok(
            json!({"action":"restore","manifestPath":destination.join("manifest.json"),"sourceReceiptDigest":receipt.source_receipt_digest,"generationId":receipt.generation_id,"identity":identity,"objectCount":expected.len(),"receiptDigest":reference.sha256,"restoreMs":started.elapsed().as_secs_f64()*1000.0}),
        )
    })();
    if result.is_err() {
        fs::remove_dir(&next)?;
    }
    result
}
