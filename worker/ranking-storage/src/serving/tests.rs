use super::*;
use ranking_contracts::{canonical_json_value, gzip};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

#[derive(Clone)]
struct Response {
    status: u16,
    body: Vec<u8>,
    headers: BTreeMap<String, String>,
}
impl Response {
    fn json(value: &Value) -> Self {
        let body = canonical_json_value(value).into_bytes();
        Self::document(body)
    }
    fn document(body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: BTreeMap::from([
                ("content-length".into(), body.len().to_string()),
                ("content-type".into(), JSON_TYPE.into()),
                ("etag".into(), format!("\"{}\"", sha256(&body))),
                ("x-amz-meta-sha256".into(), sha256(&body)),
                ("x-amz-meta-semantic-bytes".into(), body.len().to_string()),
            ]),
            body,
        }
    }
    fn immutable(semantic: &[u8]) -> Self {
        let mut response = Self::document(gzip(semantic).unwrap());
        response
            .headers
            .insert("content-encoding".into(), "gzip".into());
        response.headers.insert(
            "cache-control".into(),
            "public, max-age=31536000, immutable".into(),
        );
        response
            .headers
            .insert("x-amz-meta-sha256".into(), sha256(semantic));
        response.headers.insert(
            "x-amz-meta-semantic-bytes".into(),
            semantic.len().to_string(),
        );
        response
            .headers
            .insert("x-amz-meta-encoding".into(), "gzip".into());
        response
    }
}

#[derive(Default)]
struct State {
    objects: BTreeMap<String, Response>,
    requests: Vec<(String, String)>,
}
struct Fixture {
    state: Arc<Mutex<State>>,
    task: JoinHandle<()>,
    origin: PublishedOrigin,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(redirect: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let server_state = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(stream.read_u8().await.unwrap());
                    assert!(headers.len() < 16_384);
                }
                let request = String::from_utf8(headers).unwrap();
                assert!(
                    request
                        .to_ascii_lowercase()
                        .contains("authorization: aws4-hmac-sha256")
                );
                let mut line = request.lines().next().unwrap().split_whitespace();
                let method = line.next().unwrap();
                let path = line.next().unwrap();
                assert!(matches!(method, "GET" | "HEAD"));
                let response = {
                    let mut state = server_state.lock().unwrap();
                    state.requests.push((method.into(), path.into()));
                    state
                        .objects
                        .get(path)
                        .cloned()
                        .unwrap_or_else(|| Response {
                            status: 404,
                            body: Vec::new(),
                            headers: BTreeMap::from([("content-length".into(), "0".into())]),
                        })
                };
                let mut wire = format!("HTTP/1.1 {} OK\r\nConnection: close\r\n", response.status);
                for (name, value) in response.headers {
                    wire.push_str(&format!("{name}: {value}\r\n"));
                }
                wire.push_str("\r\n");
                if stream.write_all(wire.as_bytes()).await.is_err() {
                    continue;
                }
                if method != "HEAD" {
                    let _ = stream.write_all(&response.body).await;
                }
            }
        });
        Self {
            state,
            task,
            origin: PublishedOrigin {
                transport: Transport::fixture(&endpoint, redirect),
                admission: Arc::new(Semaphore::new(2)),
                root_cache: Mutex::new(None),
            },
        }
    }
    fn put(&self, key: &str, object: Response) {
        self.state
            .lock()
            .unwrap()
            .objects
            .insert(format!("/fixture/rankings/{key}"), object);
    }
    fn requests(&self) -> Vec<(String, String)> {
        self.state.lock().unwrap().requests.clone()
    }

    fn generation(&self, id: &str, version: u64, bound: bool) -> (Response, Value) {
        let semantic = canonical_json_value(&json!({
            "artifactKind":"public-semantic-artifact", "schemaVersion":1,
            "content":{"artifactKind":"public-ranking-manifest", "generation":id}
        }))
        .into_bytes();
        let hash = sha256(&semantic);
        let root = Response::immutable(&semantic);
        self.put(&format!("objects/sha256/{hash}"), root.clone());
        let manifest = Response::json(&json!({
            "artifactKind":"public-artifact-generation-manifest", "schemaVersion":version,
            "storageMode":"content-addressed-gzip-v1", "generationId":id, "runId":id,
            "generatedAt":"2026-10-19T12:00:00.000Z", "model":{"version":"model", "configHash":"hash"},
            "provenance":{"source":"fixture", "dataMode":"test", "sourceProviders":["fixture"]},
            "rootArtifact":"/data/ranking-summary.json",
            "artifacts":{"/data/ranking-summary.json":{
                "logicalPath":"/data/ranking-summary.json", "objectUrl":format!("/data/objects/sha256/{hash}"),
                "generationId":id, "sha256":hash, "bytes":semantic.len(), "encoding":"gzip",
                "storageEncoding":"gzip", "transportEncodings":["identity","gzip"]
            }}
        }));
        self.put(&format!("generations/{id}/manifest.json"), manifest.clone());
        let mut pointer = json!({
            "schemaVersion":1, "generationId":id, "storageMode":"content-addressed-gzip-v1",
            "manifestKey":format!("rankings/generations/{id}/manifest.json"),
            "manifestDigest":sha256(&manifest.body), "manifestBytes":manifest.body.len(),
            "manifestEtag":manifest.headers["etag"]
        });
        if bound {
            let raw = "b".repeat(64);
            let receipt = Response::json(&json!({
                "artifactKind":"ranking-generation-publication-readiness", "schemaVersion":1, "status":"ready",
                "generationId":id, "preparedAt":"2026-10-19T12:00:00.000Z", "prefix":"rankings",
                "fencing":{"token":1,"owner":"fixture","promotionEtag":"prior"},
                "provenance":{"modelVersion":"model","modelConfigHash":"hash","source":"fixture","dataMode":"test","sourceProviders":["fixture"]},
                "authorities":{
                    "publicManifest":{"key":pointer["manifestKey"],"digest":pointer["manifestDigest"],"bytes":manifest.body.len()},
                    "rawReceipt":{"key":format!("rankings/raw/objects/sha256/{raw}"),"digest":raw,"bytes":10}
                },
                "objects":[
                    {"key":pointer["manifestKey"],"digest":pointer["manifestDigest"],"bytes":manifest.body.len(),"outcome":"uploaded"},
                    {"key":format!("rankings/raw/objects/sha256/{raw}"),"digest":raw,"bytes":10,"outcome":"uploaded"},
                    {"key":format!("rankings/objects/sha256/{hash}"),"digest":hash,"bytes":root.body.len(),"outcome":"uploaded"}
                ]
            }));
            self.put(&format!("generations/{id}/publish.json"), receipt.clone());
            pointer["publicManifestSchemaVersion"] = json!(2);
            pointer["publicationSchemaVersion"] = json!(1);
            pointer["publicationReceiptKey"] =
                json!(format!("rankings/generations/{id}/publish.json"));
            pointer["publicationReceiptDigest"] = json!(sha256(&receipt.body));
            pointer["publicationReceiptBytes"] = json!(receipt.body.len());
            pointer["publicationReceiptEtag"] = json!(receipt.headers["etag"]);
        }
        self.put("active-generation.json", Response::json(&pointer));
        (manifest, pointer)
    }
}

#[tokio::test]
async fn direct_objects_verify_transport_without_requiring_a_semantic_envelope() {
    let fixture = Fixture::new(false).await;
    let semantic = br#"{"artifactKind":"public-artifact-directory","entries":[]}"#;
    let hash = sha256(semantic);
    let path = format!("objects/sha256/{hash}");
    let object = Response::immutable(semantic);
    fixture.put(&path, object.clone());
    let served = fixture
        .origin
        .read(&path, Some("missing-generation"), false, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&*served.body, object.body);
    assert_eq!(served.semantic_body.as_ref().unwrap().as_ref(), semantic);
    assert_eq!(served.semantic_length, Some(semantic.len() as u64));
    assert_eq!(fixture.requests().len(), 1);
}

#[tokio::test]
async fn immutable_head_and_presigning_do_not_download_object_bodies() {
    let fixture = Fixture::new(true).await;
    let semantic = b"real body";
    let path = format!("objects/sha256/{}", sha256(semantic));
    fixture.put(&path, Response::immutable(semantic));
    let metadata = fixture
        .origin
        .read(&path, None, true, false)
        .await
        .unwrap()
        .unwrap();
    assert!(metadata.body.is_empty());
    assert_eq!(metadata.semantic_length, Some(9));
    drop(metadata);
    let redirect = fixture
        .origin
        .read(&path, None, false, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(redirect.status, 307);
    assert!(
        redirect
            .redirect
            .as_ref()
            .unwrap()
            .contains("X-Amz-Expires=3600")
    );
    assert!(
        fixture
            .requests()
            .iter()
            .all(|(method, _)| method == "HEAD")
    );
}

#[tokio::test]
async fn failed_presign_metadata_uses_the_verified_get_proxy() {
    let fixture = Fixture::new(true).await;
    let semantic = b"proxy recovery";
    let path = format!("objects/sha256/{}", sha256(semantic));
    let mut object = Response::immutable(semantic);
    object.headers.remove("cache-control");
    fixture.put(&path, object);
    let served = fixture
        .origin
        .read(&path, None, false, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(served.status, 200);
    assert_eq!(served.semantic_body.unwrap().as_ref(), semantic);
    assert_eq!(
        fixture
            .requests()
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["HEAD", "GET"]
    );
}

#[tokio::test]
async fn pointer_is_reread_and_only_valid_immutable_roots_are_cached() {
    let fixture = Fixture::new(false).await;
    let (first, _) = fixture.generation("one", 2, true);
    for _ in 0..2 {
        let served = fixture
            .origin
            .read(ROOT, None, false, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&*served.body, first.body);
    }
    assert_eq!(
        fixture
            .requests()
            .iter()
            .filter(|(_, path)| path.ends_with("active-generation.json"))
            .count(),
        2
    );
    assert_eq!(
        fixture
            .requests()
            .iter()
            .filter(|(_, path)| path.ends_with("/manifest.json"))
            .count(),
        1
    );
    let failed_object = format!("objects/sha256/{}", "a".repeat(64));
    fixture.put(&failed_object, Response::json(&json!({"corrupt": true})));
    assert!(
        fixture
            .origin
            .read(&failed_object, None, false, false)
            .await
            .is_err()
    );
    let served = fixture
        .origin
        .read(ROOT, None, false, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&*served.body, first.body);
    drop(served);
    assert_eq!(
        fixture
            .requests()
            .iter()
            .filter(|(_, path)| path.ends_with("/manifest.json"))
            .count(),
        1
    );
    let (second, _) = fixture.generation("two", 2, true);
    let served = fixture
        .origin
        .read(ROOT, None, false, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&*served.body, second.body);
    drop(served);
    let (_, mut pointer) = fixture.generation("three", 2, true);
    pointer["manifestDigest"] = json!("0".repeat(64));
    fixture.put("active-generation.json", Response::json(&pointer));
    assert!(fixture.origin.read(ROOT, None, false, false).await.is_err());
    assert!(fixture.origin.root_cache.lock().unwrap().is_none());
}

#[tokio::test]
async fn legacy_cutover_preserves_wire_contract_and_pinned_reads_preserve_original_bytes() {
    let fixture = Fixture::new(false).await;
    let (manifest, _) = fixture.generation("legacy", 1, false);
    let served = fixture
        .origin
        .read(ROOT, None, false, false)
        .await
        .unwrap()
        .unwrap();
    let converted: Value = serde_json::from_slice(&served.body).unwrap();
    assert_eq!(converted["schemaVersion"], 2);
    assert!(served.etag.as_ref().unwrap().starts_with("\"cutover-v2-"));
    drop(served);
    let pinned = fixture
        .origin
        .read(ROOT, Some("legacy"), false, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&*pinned.body, manifest.body);
    drop(pinned);
    fixture.put(
        "data/missing.json",
        Response::json(&json!({"fallback":true})),
    );
    assert!(
        fixture
            .origin
            .read("missing.json", Some("absent"), false, false)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!fixture.requests().iter().any(|(_, path)| path.ends_with("data/missing.json") && !path.contains("/generations/")));
}

#[tokio::test]
async fn corruption_metadata_and_declared_semantic_limit_fail_before_delivery() {
    let fixture = Fixture::new(false).await;
    let semantic = b"checked bytes";
    let path = format!("objects/sha256/{}", sha256(semantic));
    for change in 0..4 {
        let mut object = Response::immutable(semantic);
        match change {
            0 => {
                object
                    .headers
                    .insert("x-amz-meta-sha256".into(), "0".repeat(64));
            }
            1 => {
                let end = object.body.len() - 8;
                object.body[end] ^= 1;
            }
            2 => {
                object.headers.insert(
                    "x-amz-meta-semantic-bytes".into(),
                    (SEMANTIC_LIMIT + 1).to_string(),
                );
            }
            _ => {
                object
                    .headers
                    .insert("x-amz-meta-semantic-bytes".into(), "1".into());
            }
        }
        fixture.put(&path, object);
        assert!(
            fixture
                .origin
                .read(&path, None, false, false)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn body_owners_retain_admission_and_the_next_read_waits() {
    let fixture = Fixture::new(false).await;
    fixture.put("data/a.json", Response::json(&json!({"ok":true})));
    let first = fixture
        .origin
        .read("a.json", Some(""), false, false)
        .await
        .unwrap()
        .unwrap();
    let second = fixture
        .origin
        .read("a.json", Some(""), false, false)
        .await
        .unwrap()
        .unwrap();
    let body_owner = first.body.clone();
    drop(first);
    let next = fixture.origin.read("a.json", None, false, false);
    tokio::pin!(next);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut next)
            .await
            .is_err()
    );
    drop(body_owner);
    let third = tokio::time::timeout(Duration::from_secs(1), next)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!third.body.is_empty());
    drop(second);
}

#[tokio::test]
async fn gzip_members_padding_checksums_and_limits_match_retained_transport() {
    let joined = [gzip(b"one").unwrap(), gzip(b"two").unwrap(), vec![0, 255]].concat();
    assert_eq!(decode(&joined, None, 6).await.unwrap(), b"onetwo");
    assert!(decode(&joined, None, 5).await.is_err());
    for size in 0..gzip(b"one").unwrap().len() {
        assert!(
            decode(&gzip(b"one").unwrap()[..size], None, 3)
                .await
                .is_err()
        );
    }
    let mut long_header = gzip(b"body").unwrap();
    long_header[3] |= 8;
    long_header.splice(10..10, [vec![b'x'; 1024], vec![0]].concat());
    assert_eq!(decode(&long_header, None, 4).await.unwrap(), b"body");
}

#[test]
fn unsafe_requested_paths_fail_before_storage_and_signing() {
    for path in [
        "",
        "../a",
        "a//b",
        "a\\b",
        "a/%2e%2e/b",
        "a/%2f",
        "a/%5c",
        "a/%",
        "a/%ff",
    ] {
        assert!(validate_path(path).is_err(), "{path}");
    }
    assert!(validate_path("objects/sha256/abc").is_ok());
    assert!(validate_path("teams/%C3%A9.json").is_ok());
}

#[tokio::test]
async fn publication_provenance_and_stored_membership_are_required() {
    for mismatch in ["provenance", "membership"] {
        let fixture = Fixture::new(false).await;
        let (_, mut pointer) = fixture.generation("bound", 2, true);
        let mut receipt: Value = serde_json::from_slice(&fixture.state.lock().unwrap().objects["/fixture/rankings/generations/bound/publish.json"].body).unwrap();
        if mismatch == "provenance" {
            receipt["provenance"]["modelVersion"] = json!("other-model");
        } else {
            receipt["objects"][2]["bytes"] = json!(1);
        }
        let receipt = Response::json(&receipt);
        pointer["publicationReceiptDigest"] = json!(sha256(&receipt.body));
        pointer["publicationReceiptBytes"] = json!(receipt.body.len());
        pointer["publicationReceiptEtag"] = json!(receipt.headers["etag"]);
        fixture.put("generations/bound/publish.json", receipt);
        fixture.put("active-generation.json", Response::json(&pointer));
        assert!(
            fixture.origin.read(ROOT, None, false, false).await.is_err(),
            "{mismatch}"
        );
    }
}

#[tokio::test]
async fn retained_native_schema_requires_its_canonical_publish_receipt() {
    let fixture = Fixture::new(false).await;
    let (manifest, mut pointer) = fixture.generation("native", 2, false);
    let raw = "b".repeat(64);
    let public = json!({"key":pointer["manifestKey"], "digest":pointer["manifestDigest"], "bytes":manifest.body.len(), "contentType":JSON_TYPE});
    let raw = json!({"key":format!("rankings/raw/objects/sha256/{raw}"), "digest":raw, "bytes":10, "contentType":JSON_TYPE});
    pointer["publicManifestSchemaVersion"] = json!(2);
    pointer["rawReceiptKey"] = raw["key"].clone();
    pointer["rawReceiptDigest"] = raw["digest"].clone();
    pointer["rawReceiptCompressedBytes"] = json!(10);
    let receipt = json!({
        "schemaVersion":2, "storageMode":"content-addressed-gzip-v1", "generationId":"native",
        "publishedAt":"2026-10-19T12:00:00.000Z", "prefix":"rankings", "artifactCount":2,
        "uploadedCount":2, "uploadedBytes":manifest.body.len()+10, "unchangedCount":0, "unchangedBytes":0,
        "artifacts":[public, raw], "unchanged":[], "skipped":[],
        "authorities":{"publicManifest":public, "rawReceipt":raw}
    });
    fixture.put("active-generation.json", Response::json(&pointer));
    let mut corrupt = receipt.clone();
    corrupt["uploadedBytes"] = json!(0);
    fixture.put("generations/native/publish.json", Response::json(&corrupt));
    assert!(fixture.origin.read(ROOT, None, false, false).await.is_err());
    fixture.put("generations/native/publish.json", Response::json(&receipt));
    let served = fixture
        .origin
        .read(ROOT, None, false, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&*served.body, manifest.body);
}

#[tokio::test]
async fn oversized_stored_length_is_rejected_before_body_materialization() {
    let fixture = Fixture::new(false).await;
    let mut response = Response::json(&json!({"bounded":true}));
    response
        .headers
        .insert("content-length".into(), (STORED_LIMIT + 1).to_string());
    fixture.put("data/large.json", response);
    assert!(
        fixture
            .origin
            .read("large.json", None, false, false)
            .await
            .is_err()
    );
    assert_eq!(fixture.origin.admission.available_permits(), 2);
}
