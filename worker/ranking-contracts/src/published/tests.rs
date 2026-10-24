use super::*;
use crate::{Utf16String, gzip};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Cases {
    dates: Vec<DateCase>,
    references: Vec<ReferenceCase>,
}
#[derive(Deserialize)]
struct DateCase {
    value: Utf16String,
    canonical: bool,
    #[serde(rename = "nodeValid")]
    node_valid: bool,
}
#[derive(Deserialize)]
struct ReferenceCase {
    content: String,
    canonical: String,
    paths: Vec<Utf16String>,
}
fn cases() -> Cases {
    serde_json::from_str(include_str!("tests/oracle-cases.json")).unwrap()
}

#[test]
fn served_archives_bound_repeated_references_before_hydrating_their_expansion() {
    let mut objects = BTreeMap::new();
    let leaf = Stored::content(
        &json!({
            "artifactKind":"public-archive-node", "formatVersion":1,
            "tree":{"kind":"inline","value":[0]}
        })
        .to_string(),
    );
    let mut previous = leaf.identity.clone();
    objects.insert(previous.digest().to_owned(), leaf);
    let mut count = 1u64;
    for _ in 0..20 {
        let reference = json!({"sha256":previous.digest(),"bytes":previous.bytes(),"count":count,"encoding":"gzip"});
        let node = Stored::content(
            &json!({
                "artifactKind":"public-archive-node", "formatVersion":1,
                "tree":{"kind":"list","parts":[reference.clone(),reference.clone(),reference]}
            })
            .to_string(),
        );
        previous = node.identity.clone();
        objects.insert(previous.digest().to_owned(), node);
        count *= 3;
    }
    assert!(count > 3_000_000_000);
    assert_eq!(objects.len(), 21);
    let mut reads = 0;
    let result = verify_served_artifact(
        previous.digest(),
        previous.bytes(),
        &mut |identity| {
            reads += 1;
            objects[identity.digest()].checked()
        },
        &mut || Ok(()),
    );
    assert!(result.err().unwrap().contains("serving traversal limit"));
    assert_eq!(reads, 1);
}

#[test]
fn served_document_traversal_stops_at_a_cancellation_checkpoint() {
    let stored =
        Stored::content(&json!({"artifactKind":"fixture","values":vec![0;1024]}).to_string());
    let mut checks = 0;
    let result = verify_served_artifact(
        stored.identity.digest(),
        stored.identity.bytes(),
        &mut |_| stored.checked(),
        &mut || {
            checks += 1;
            if checks == 10 {
                return Err("cancelled traversal".into());
            }
            Ok(())
        },
    );
    assert_eq!(result.err().unwrap(), "cancelled traversal");
    assert_eq!(checks, 10);
}

struct Stored {
    identity: PublicIdentity,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
impl Stored {
    fn content(content: &str) -> Self {
        let semantic = format!(
            r#"{{"artifactKind":"public-semantic-artifact","schemaVersion":1,"content":{content}}}"#
        );
        let identity =
            PublicIdentity::new(&sha256(semantic.as_bytes()), semantic.len() as u64).unwrap();
        Self::encoded(identity, gzip(semantic.as_bytes()).unwrap())
    }
    fn encoded(identity: PublicIdentity, body: Vec<u8>) -> Self {
        let headers = BTreeMap::from([
            ("content-encoding".into(), "gzip".into()),
            ("content-length".into(), body.len().to_string()),
            ("x-amz-meta-sha256".into(), identity.digest().into()),
            (
                "x-amz-meta-semantic-bytes".into(),
                identity.bytes().to_string(),
            ),
            ("x-amz-meta-encoding".into(), "gzip".into()),
        ]);
        Self {
            identity,
            headers,
            body,
        }
    }
    fn checked(&self) -> Result<PublicObject> {
        PublicObject::check(&self.identity, &self.headers, &self.body)
    }
    fn verify(&self) -> Result<ArtifactVerification> {
        verify_artifact(self.identity.digest(), self.identity.bytes(), &mut |_| {
            self.checked()
        })
    }
}

fn checked_generation(
    contents: &[(&str, &str)],
    date: &Utf16String,
    scope: GenerationScope,
) -> GenerationVerification {
    let objects = contents
        .iter()
        .map(|(path, content)| (*path, Stored::content(content)))
        .collect::<Vec<_>>();
    let mut artifacts = serde_json::Map::new();
    for (path, stored) in &objects {
        artifacts.insert((*path).into(), json!({
            "logicalPath": path, "objectUrl": format!("/data/objects/sha256/{}", stored.identity.digest()),
            "generationId":"g", "sha256":stored.identity.digest(), "bytes":stored.identity.bytes(),
            "encoding":"gzip", "storageEncoding":"gzip", "transportEncodings":["identity","gzip"],
        }));
    }
    let manifest = json!({
        "artifactKind":"public-artifact-generation-manifest", "schemaVersion":2,
        "storageMode":"content-addressed-gzip-v1", "generationId":"g", "runId":"g",
        "generatedAt":"__date__", "model":{"version":"model", "configHash":"hash"},
        "provenance":{"source":"synthetic", "dataMode":"test", "sourceProviders":["fixture"]},
        "rootArtifact":"/data/ranking-summary.json", "artifacts":artifacts,
    });
    let mut date_json = String::new();
    date.write_json(&mut date_json);
    let body = manifest
        .to_string()
        .replace("\"__date__\"", &date_json)
        .into_bytes();
    let digest = sha256(&body);
    let authority: ManifestAuthority = serde_json::from_value(json!({
        "key":"rankings/generations/g/manifest.json", "etag":"etag", "bytes":body.len(), "digest":digest,
    })).unwrap();
    let headers = BTreeMap::from([
        ("content-length".into(), body.len().to_string()),
        ("content-type".into(), JSON_TYPE.into()),
        ("x-amz-meta-sha256".into(), digest),
        ("x-amz-meta-semantic-bytes".into(), body.len().to_string()),
    ]);
    SuppliedGeneration::new(
        authority,
        r#"{"generationId":"g","publicManifestSchemaVersion":2}"#,
        "rankings",
    )
    .unwrap()
    .check(
        IdentityMetadata {
            etag: "etag",
            headers: &headers,
        },
        &body,
        scope,
        &mut |identity| {
            objects
                .iter()
                .find(|(_, stored)| &stored.identity == identity)
                .unwrap()
                .1
                .checked()
        },
    )
    .unwrap()
}

#[test]
fn checked_documents_match_shared_node_reference_cases() {
    for row in cases().references {
        let stored = Stored::content(&row.content);
        let verified = stored.verify().unwrap();
        assert_eq!(verified.document().canonical_json(), row.canonical);
        assert_eq!(verified.document().references().unwrap(), row.paths);
    }
}

#[test]
fn canonical_proof_keeps_deferred_dates_and_original_utf16_text() {
    for row in cases().dates {
        let verified = checked_generation(
            &[("/data/ranking-summary.json", "{}")],
            &row.value,
            GenerationScope::Structure,
        );
        let proof = verified.canonical_date();
        assert_eq!(proof.is_ok(), row.canonical, "{:?}", row.value);
        if let Ok(proof) = proof {
            assert_eq!(Utf16String::from(proof.as_str()), row.value);
        }
        let output = verified.result_json("rankings");
        assert!(output.contains("\"needsNodeDateValidation\":true"));
        let mut expected = String::from("\"generatedAt\":");
        row.value.write_json(&mut expected);
        assert!(output.contains(&expected));
        assert!(verified.reference_graph().is_err());
    }
}

#[test]
fn complete_logical_graph_proof_is_separate_from_cli_artifact_integrity() {
    let root = r#"{"artifactKind":"public-ranking-manifest","playerDirectoryUrl":"/data/players.json?v=g"}"#;
    let complete = checked_generation(
        &[
            ("/data/ranking-summary.json", root),
            ("/data/players.json", "{}"),
        ],
        &"2026-10-08T09:28:28.547Z".into(),
        GenerationScope::Artifacts,
    );
    complete.reference_graph().unwrap().assert_closed().unwrap();
    let missing = checked_generation(
        &[("/data/ranking-summary.json", root)],
        &"2026-10-08T09:28:28.547Z".into(),
        GenerationScope::Artifacts,
    );
    assert!(missing.reference_graph().unwrap().assert_closed().is_err());
    let result: Value = serde_json::from_str(&missing.result_json("rankings")).unwrap();
    assert_eq!(result["needsNodeDateValidation"], true);
    assert_eq!(
        result["rootArtifact"]["playerDirectoryUrl"],
        "/data/players.json?v=g"
    );
}

#[test]
fn byte_proof_precedes_document_and_archive_checks() {
    let stored = Stored::content(r#"{"n":1e400,"dup":1,"dup":2,"text":"\ud800"}"#);
    assert_eq!(
        stored.verify().unwrap().document().canonical_json(),
        r#"{"dup":2,"n":null,"text":"\ud800"}"#
    );
    for offset in [stored.body.len() - 8, stored.body.len() - 4] {
        let mut corrupt = stored.body.clone();
        corrupt[offset] ^= 1;
        assert!(
            Stored::encoded(stored.identity.clone(), corrupt)
                .checked()
                .is_err()
        );
    }
    let mut padded = stored.body.clone();
    padded.extend_from_slice(&[0, 0, 255, 1]);
    assert!(
        Stored::encoded(stored.identity.clone(), padded)
            .verify()
            .is_ok()
    );
    let mut wrong = stored.headers.clone();
    wrong.insert("x-amz-meta-semantic-bytes".into(), "1".into());
    assert!(PublicObject::check(&stored.identity, &wrong, &stored.body).is_err());
    let semantic = r#"{"artifactKind":"public-semantic-artifact","schemaVersion":1,"content":{"n":1e400,"dup":1,"dup":2,"text":"\ud800"}}"#;
    let half = semantic.len() / 2;
    let concatenated = [
        gzip(&semantic.as_bytes()[..half]).unwrap(),
        gzip(&semantic.as_bytes()[half..]).unwrap(),
    ]
    .concat();
    assert!(
        Stored::encoded(stored.identity.clone(), concatenated)
            .verify()
            .is_ok()
    );
    let other = Stored::content("{}");
    assert!(
        verify_artifact(
            stored.identity.digest(),
            stored.identity.bytes(),
            &mut |_| other.checked()
        )
        .is_err()
    );
    assert!(Stored::content("[]").checked().is_err());
}

#[test]
fn archive_hydration_preserves_undefined_and_checks_child_count() {
    let child = Stored::content(
        r#"{"artifactKind":"public-archive-node","formatVersion":1,"tree":{"kind":"record","entries":[["kept",{"kind":"inline","value":1}],["absent",{"kind":"inline"}]]}}"#,
    );
    let make_root = |count| {
        Stored::content(&json!({
        "artifactKind":"public-artifact-archive", "originalKind":"test", "formatVersion":1,
        "tree":{"kind":"record", "entries":[
            ["artifactKind", {"kind":"inline", "value":"test"}],
            ["rows", {"kind":"map", "parts":[{"sha256":child.identity.digest(), "bytes":child.identity.bytes(), "count":count, "encoding":"gzip"}]}],
        ]},
    }).to_string())
    };
    let root = make_root(2);
    let verified = verify_artifact(
        root.identity.digest(),
        root.identity.bytes(),
        &mut |identity| {
            if identity == &root.identity {
                root.checked()
            } else {
                child.checked()
            }
        },
    )
    .unwrap();
    assert_eq!(
        verified.document().canonical_json(),
        r#"{"artifactKind":"test","rows":{"kept":1}}"#
    );
    let bad = make_root(1);
    assert!(
        verify_artifact(
            bad.identity.digest(),
            bad.identity.bytes(),
            &mut |identity| {
                if identity == &bad.identity {
                    bad.checked()
                } else {
                    child.checked()
                }
            }
        )
        .is_err()
    );
}

#[test]
fn directory_without_a_reference_keeps_lossless_parse_semantics() {
    let verified = verify_directory(
        r#"{"n":1e400,"text":"\ud800","dup":1,"dup":2}"#,
        &mut |_| panic!("no reference to read"),
    )
    .unwrap();
    assert_eq!(
        verified.result_json(""),
        r#"{"manifest":{"dup":2,"n":null,"text":"\ud800"},"verifiedObjects":[]}"#
    );
}

struct PublicationFixture {
    active: Vec<u8>,
    bytes: Vec<u8>,
    headers: BTreeMap<String, String>,
    bodies: Vec<(String, Vec<u8>)>,
}

fn publication_fixture(prepared: &str, token: Value, duplicate: bool) -> PublicationFixture {
    let semantic = b"{}";
    let digest = sha256(semantic);
    let compressed = gzip(semantic).unwrap();
    let manifest_key = "rankings/generations/g/manifest.json";
    let raw_key = format!("rankings/raw/objects/sha256/{digest}");
    let manifest = json!({"key":manifest_key, "digest":digest, "bytes":semantic.len()});
    let raw = json!({"key":raw_key, "digest":digest, "bytes":compressed.len()});
    let mut members = vec![
        json!({"key":manifest_key, "digest":digest, "bytes":semantic.len(), "outcome":"uploaded"}),
        json!({"key":raw_key, "digest":digest, "bytes":compressed.len(), "outcome":"reused"}),
    ];
    if duplicate {
        members.push(members[0].clone());
    }
    let receipt = json!({
        "artifactKind":"ranking-generation-publication-readiness", "schemaVersion":1,
        "status":"ready", "generationId":"g", "preparedAt":prepared, "prefix":"rankings",
        "fencing":{"token":1, "owner":"publisher", "promotionEtag":"previous"},
        "provenance":{"modelVersion":"m", "modelConfigHash":"h", "source":"synthetic", "dataMode":"test", "sourceProviders":["fixture"]},
        "authorities":{"publicManifest":manifest, "rawReceipt":raw}, "objects":members,
    }).to_string().into_bytes();
    let receipt_digest = sha256(&receipt);
    let active = json!({
        "publicationSchemaVersion":1, "generationId":"g", "publicationReceiptKey":"rankings/generations/g/publish.json",
        "publicationReceiptDigest":receipt_digest, "publicationReceiptBytes":receipt.len(), "publicationReceiptEtag":"receipt-etag",
        "manifestKey":manifest_key, "manifestDigest":digest, "manifestBytes":semantic.len(), "fencingToken":token,
    }).to_string().into_bytes();
    let headers = BTreeMap::from([
        ("content-length".into(), receipt.len().to_string()),
        ("content-type".into(), JSON_TYPE.into()),
        ("x-amz-meta-sha256".into(), receipt_digest),
        (
            "x-amz-meta-semantic-bytes".into(),
            receipt.len().to_string(),
        ),
    ]);
    PublicationFixture {
        active,
        bytes: receipt,
        headers,
        bodies: vec![
            ("generations/g/manifest.json".into(), semantic.to_vec()),
            (format!("raw/objects/sha256/{digest}"), compressed),
        ],
    }
}

#[test]
fn replay_evidence_uses_shared_reference_closure_and_generic_reader() {
    let root = r#"{"artifactKind":"public-ranking-manifest","replayPredictionsUrl":"/data/evaluation/replay-predictions.json?v=g"}"#;
    let replay = r#"{"artifactKind":"replay-predictions","contractVersion":1,"predictions":[],"sourceGames":[]}"#;
    let complete = checked_generation(
        &[
            ("/data/ranking-summary.json", root),
            ("/data/evaluation/replay-predictions.json", replay),
        ],
        &"2026-10-08T09:28:28.547Z".into(),
        GenerationScope::Artifacts,
    );
    complete.reference_graph().unwrap().assert_closed().unwrap();
    let missing = checked_generation(
        &[("/data/ranking-summary.json", root)],
        &"2026-10-08T09:28:28.547Z".into(),
        GenerationScope::Artifacts,
    );
    assert!(missing.reference_graph().unwrap().assert_closed().is_err());
    let retained = checked_generation(
        &[(
            "/data/ranking-summary.json",
            r#"{"artifactKind":"public-ranking-manifest"}"#,
        )],
        &"2026-10-08T09:28:28.547Z".into(),
        GenerationScope::Artifacts,
    );
    retained.reference_graph().unwrap().assert_closed().unwrap();
}

#[test]
fn checked_receipt_preserves_declared_members_pointer_coercion_and_date_binding() {
    for token in [json!(1), json!("1"), json!(true), json!([["1"]])] {
        let PublicationFixture {
            active,
            bytes,
            headers,
            bodies,
        } = publication_fixture("2026-10-08T09:28:28.547Z", token, false);
        let request = PublicationRequest::from_active(&active, "rankings")
            .unwrap()
            .unwrap();
        assert_eq!(request.relative_key(), "generations/g/publish.json");
        let receipt = request
            .check(
                IdentityMetadata {
                    etag: "receipt-etag",
                    headers: &headers,
                },
                &bytes,
            )
            .unwrap();
        for member in receipt.members() {
            let body = &bodies
                .iter()
                .find(|(key, _)| key == member.relative_key())
                .unwrap()
                .1;
            let headers = BTreeMap::from([
                ("content-length".into(), body.len().to_string()),
                ("x-amz-meta-sha256".into(), sha256(b"{}")),
            ]);
            member
                .check(
                    IdentityMetadata {
                        etag: "",
                        headers: &headers,
                    },
                    body,
                )
                .unwrap();
            let mut corrupt = body.clone();
            corrupt[0] ^= 1;
            assert!(
                member
                    .check(
                        IdentityMetadata {
                            etag: "",
                            headers: &headers
                        },
                        &corrupt
                    )
                    .is_err()
            );
        }
        let result: Value = serde_json::from_str(&receipt.result_json()).unwrap();
        assert_eq!(result["receipt"]["preparedAt"], "2026-10-08T09:28:28.547Z");
    }
    for (date, token, duplicate) in [
        ("October 11, 2026", json!(1), false),
        ("2026-10-08T09:28:28.547Z", json!([true]), false),
        ("2026-10-08T09:28:28.547Z", json!(1), true),
    ] {
        let PublicationFixture {
            active,
            bytes,
            headers,
            ..
        } = publication_fixture(date, token, duplicate);
        let request = PublicationRequest::from_active(&active, "rankings")
            .unwrap()
            .unwrap();
        assert!(
            request
                .check(
                    IdentityMetadata {
                        etag: "receipt-etag",
                        headers: &headers
                    },
                    &bytes
                )
                .is_err()
        );
    }
    assert!(
        PublicationRequest::from_active(b"{}", "rankings")
            .unwrap()
            .is_none()
    );
    assert!(
        PublicationRequest::from_active(br#"{"publicationReceiptBytes":1}"#, "rankings").is_err()
    );
}

#[test]
fn serving_dates_match_the_retained_node_oracle() {
    for row in cases().dates {
        let text = String::from_utf16(&row.value.code_units().collect::<Vec<_>>());
        let actual = text
            .as_ref()
            .is_ok_and(|text| super::date::serving_date(text));
        assert_eq!(actual, row.node_valid, "{:?}", row.value);
    }
}
