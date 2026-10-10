mod s3;

use ranking_contracts::{Result, canonical_json_value, gunzip, js_pretty_json_value, sha256};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, time::SystemTime};

const ACTIVE: &str = "active-generation.json";
const JSON_TYPE: &str = "application/json; charset=utf-8";

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
enum Input {
    SyncObject {
        namespace: String,
        #[serde(rename = "compressedPath")]
        compressed_path: String,
        digest: String,
        bytes: u64,
    },
    AcquireLease {
        key: String,
        owner: String,
        #[serde(rename = "ttlMs")]
        ttl_ms: u64,
        now: Option<String>,
    },
    RenewLease {
        key: String,
        authority: Authority,
        #[serde(rename = "ttlMs")]
        ttl_ms: u64,
        now: Option<String>,
    },
    ReleaseLease {
        key: String,
        authority: Authority,
        now: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authority {
    etag: String,
    lease: Lease,
    #[serde(default)]
    promotion_etag: Option<String>,
}

#[derive(Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lease {
    schema_version: u32,
    owner: String,
    fencing_token: u64,
    acquired_at: String,
    expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    renewed_at: Option<String>,
}

/// Native immutable object and lease primitives. Generation validation/promotion
/// remains in the Node publisher until the rest of M4 has been ported.
pub fn run(input_path: &str, output_path: &str) -> Result<()> {
    let input: Input = serde_json::from_slice(&fs::read(input_path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid storage descriptor")?;
    let bucket = s3::Bucket::from_env()?;
    let result = match input {
        Input::SyncObject {
            namespace,
            compressed_path,
            digest,
            bytes,
        } => sync_object(&bucket, &namespace, &compressed_path, &digest, bytes)?,
        Input::AcquireLease {
            key,
            owner,
            ttl_ms,
            now,
        } => acquire_lease(&bucket, &key, &owner, ttl_ms, now)?,
        Input::RenewLease {
            key,
            authority,
            ttl_ms,
            now,
        } => change_lease(&bucket, &key, &authority, Some(ttl_ms), now)?,
        Input::ReleaseLease {
            key,
            authority,
            now,
        } => change_lease(&bucket, &key, &authority, None, now)?,
    };
    fs::write(output_path, canonical_json_value(&result)).map_err(|e| e.to_string())
}

fn sync_object(
    bucket: &s3::Bucket,
    namespace: &str,
    path: &str,
    digest: &str,
    bytes: u64,
) -> Result<Value> {
    if !matches!(namespace, "raw" | "state")
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || bytes == 0
    {
        return Err("Invalid immutable object identity".into());
    }
    let compressed = fs::read(path).map_err(|e| e.to_string())?;
    let semantic = gunzip(&compressed).map_err(|_| "Invalid object gzip")?;
    if semantic.len() as u64 != bytes || sha256(&semantic) != digest {
        return Err("Object semantic identity mismatch".into());
    }
    let value: Value = serde_json::from_slice(&semantic).map_err(|_| "Invalid object JSON")?;
    if canonical_json_value(&value).as_bytes() != semantic {
        return Err("Object JSON is not canonical".into());
    }
    let key = format!("{namespace}/objects/sha256/{digest}");
    let headers = BTreeMap::from([
        ("content-type".into(), JSON_TYPE.into()),
        ("content-encoding".into(), "gzip".into()),
        ("x-amz-meta-sha256".into(), digest.into()),
        ("x-amz-meta-semantic-bytes".into(), bytes.to_string()),
        ("x-amz-meta-encoding".into(), "gzip".into()),
        ("if-none-match".into(), "*".into()),
    ]);
    let response = bucket.request(Method::PUT, &key, headers, compressed.clone())?;
    let (status, stored_bytes) = match response.status {
        200 => ("uploaded", compressed.len()),
        412 => {
            let stored = bucket.request(Method::GET, &key, BTreeMap::new(), vec![])?;
            if stored.status != 200
                || stored.headers.get("content-type").map(String::as_str) != Some(JSON_TYPE)
                || stored.headers.get("content-encoding").map(String::as_str) != Some("gzip")
                || stored.headers.get("x-amz-meta-sha256").map(String::as_str) != Some(digest)
                || stored.headers.get("x-amz-meta-semantic-bytes") != Some(&bytes.to_string())
                || stored
                    .headers
                    .get("x-amz-meta-encoding")
                    .map(String::as_str)
                    != Some("gzip")
            {
                return Err("Stored object metadata mismatch".into());
            }
            if gunzip(&stored.body).map_err(|_| "Stored object gzip is corrupt")? != semantic {
                return Err("Stored object semantic identity mismatch".into());
            }
            ("unchanged", stored.body.len())
        }
        code => return Err(format!("S3 immutable write failed with HTTP {code}")),
    };
    let full_key = if bucket.prefix.is_empty() {
        key
    } else {
        format!("{}/{key}", bucket.prefix)
    };
    Ok(
        json!({"status":status,"key":full_key,"digest":digest,"bytes":stored_bytes,"semanticBytes":bytes}),
    )
}

fn read_active(bucket: &s3::Bucket) -> Result<(Value, Option<String>)> {
    let response = bucket.request(Method::GET, ACTIVE, BTreeMap::new(), vec![])?;
    match response.status {
        404 => Ok((json!({}), None)),
        200 => {
            if response.etag.is_empty() {
                return Err("Active authority lacks ETag".into());
            }
            let value: Value = serde_json::from_slice(&response.body)
                .map_err(|_| "Invalid active authority JSON")?;
            if !value.is_object() {
                return Err("Invalid active authority".into());
            }
            Ok((value, Some(response.etag)))
        }
        code => Err(format!("S3 authority read failed with HTTP {code}")),
    }
}

fn write_active(bucket: &s3::Bucket, value: &Value, etag: Option<&str>) -> Result<Option<String>> {
    let mut headers = BTreeMap::from([("content-type".into(), JSON_TYPE.into())]);
    if let Some(etag) = etag {
        headers.insert("if-match".into(), etag.into());
    } else {
        headers.insert("if-none-match".into(), "*".into());
    }
    let response = bucket.request(
        Method::PUT,
        ACTIVE,
        headers,
        format!("{}\n", js_pretty_json_value(value)).into_bytes(),
    )?;
    match response.status {
        200 if !response.etag.is_empty() => Ok(Some(response.etag)),
        412 => Ok(None),
        code => Err(format!("S3 authority write failed with HTTP {code}")),
    }
}

fn acquire_lease(
    bucket: &s3::Bucket,
    key: &str,
    owner: &str,
    ttl_ms: u64,
    now: Option<String>,
) -> Result<Value> {
    validate_lease_inputs(key, owner, ttl_ms)?;
    let now = instant(now)?;
    let (mut active, etag) = read_active(bucket)?;
    if active.get("leaseOwner").is_some() {
        let expiry = parsed_time(&active["leaseExpiresAt"])?;
        if expiry > now && active["leaseOwner"].as_str() != Some(owner) {
            return Ok(json!({"acquired":false,"reason":"active-lease","lease":{
                "owner":active["leaseOwner"], "fencingToken":active["leaseFencingToken"],
                "acquiredAt":active["leaseAcquiredAt"], "expiresAt":active["leaseExpiresAt"]
            }}));
        }
    }
    let token = ["leaseFencingToken", "fencingToken"]
        .into_iter()
        .map(|key| {
            active.get(key).map_or(Ok(0), |v| {
                v.as_u64()
                    .ok_or_else(|| "Invalid active fencing token".to_owned())
            })
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("Fencing token overflow")?;
    if token > 9_007_199_254_740_991 {
        return Err("Fencing token exceeds JavaScript safe integer".into());
    }
    let lease = Lease {
        schema_version: 1,
        owner: owner.into(),
        fencing_token: token,
        acquired_at: iso(now),
        expires_at: iso(expiry(now, ttl_ms)?),
        renewed_at: None,
    };
    active["schemaVersion"] = json!(1);
    active["leaseKey"] = json!(key);
    active["leaseOwner"] = json!(owner);
    active["leaseFencingToken"] = json!(token);
    active["leaseAcquiredAt"] = json!(lease.acquired_at);
    active["leaseExpiresAt"] = json!(lease.expires_at);
    match write_active(bucket, &active, etag.as_deref())? {
        Some(etag) => Ok(json!({"acquired":true,"lease":lease,"etag":etag,"promotionEtag":etag})),
        None => Ok(json!({"acquired":false,"reason":"lease-race"})),
    }
}

fn change_lease(
    bucket: &s3::Bucket,
    key: &str,
    authority: &Authority,
    ttl_ms: Option<u64>,
    now: Option<String>,
) -> Result<Value> {
    validate_lease_inputs(key, &authority.lease.owner, ttl_ms.unwrap_or(1))?;
    let now = instant(now)?;
    let (mut active, etag) = read_active(bucket)?;
    let reason = if authority.etag.is_empty()
        || authority.lease.schema_version != 1
        || authority
            .promotion_etag
            .as_ref()
            .is_some_and(|v| v != &authority.etag)
    {
        Some("invalid-lease")
    } else if etag.is_none() {
        Some("lease-missing")
    } else if etag.as_deref() != Some(&authority.etag) {
        Some("lease-changed")
    } else if active["leaseKey"].as_str() != Some(key) {
        Some("lease-key-changed")
    } else if active["leaseOwner"].as_str() != Some(&authority.lease.owner) {
        Some("lease-owner-changed")
    } else if active["leaseFencingToken"].as_u64() != Some(authority.lease.fencing_token) {
        Some("lease-token-changed")
    } else if parsed_time(&active["leaseExpiresAt"])? <= now {
        Some("lease-expired")
    } else {
        None
    };
    let field = if ttl_ms.is_some() {
        "renewed"
    } else {
        "released"
    };
    if let Some(reason) = reason {
        return Ok(json!({field:false,"reason":reason}));
    }
    let mut lease = authority.lease.clone();
    if let Some(ttl) = ttl_ms {
        lease.expires_at = iso(expiry(now, ttl)?);
        lease.renewed_at = Some(iso(now));
        active["leaseExpiresAt"] = json!(lease.expires_at);
        active["leaseRenewedAt"] = json!(iso(now));
    } else {
        active["leaseExpiresAt"] = json!(iso(now));
        active["leaseReleasedAt"] = json!(iso(now));
    }
    match write_active(bucket, &active, Some(&authority.etag))? {
        Some(etag) if ttl_ms.is_some() => {
            Ok(json!({"renewed":true,"lease":lease,"etag":etag,"promotionEtag":etag}))
        }
        Some(etag) => Ok(json!({"released":true,"etag":etag})),
        None => Ok(json!({field:false,"reason":"lease-changed"})),
    }
}

fn validate_lease_inputs(key: &str, owner: &str, ttl: u64) -> Result<()> {
    s3::validate_key(key)?;
    if owner.is_empty() || ttl == 0 || ttl > 86_400_000 {
        return Err("Invalid lease owner or TTL".into());
    }
    Ok(())
}
fn instant(value: Option<String>) -> Result<chrono::DateTime<chrono::Utc>> {
    value.map_or_else(
        || Ok(chrono::DateTime::from(SystemTime::now())),
        |value| parsed_time(&json!(value)),
    )
}
fn parsed_time(value: &Value) -> Result<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value.as_str().ok_or("Invalid lease time")?)
        .map(|v| v.with_timezone(&chrono::Utc))
        .map_err(|_| "Invalid lease time".into())
}
fn expiry(now: chrono::DateTime<chrono::Utc>, ttl: u64) -> Result<chrono::DateTime<chrono::Utc>> {
    now.checked_add_signed(chrono::Duration::milliseconds(ttl as i64))
        .ok_or_else(|| "Lease time overflow".into())
}
fn iso(value: chrono::DateTime<chrono::Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
