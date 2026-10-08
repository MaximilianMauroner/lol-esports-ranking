use ranking_contracts::*;
use serde_json::{Value as Json, json};

fn fixtures() -> Json {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/parity/contracts.json"
    ))
    .unwrap()
}
fn bits(value: &Json) -> f64 {
    f64::from_bits(u64::from_str_radix(value.as_str().unwrap(), 16).unwrap())
}
fn encoded(value: &Json) -> Value {
    match value.get("$type").and_then(Json::as_str) {
        Some("undefined") => Value::Undefined,
        Some("number") => Value::Number(bits(&value["bits"])),
        Some("map") => Value::Map(
            value["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| (encoded(&entry[0]), encoded(&entry[1])))
                .collect(),
        ),
        Some("set") => Value::Set(
            value["values"]
                .as_array()
                .unwrap()
                .iter()
                .map(encoded)
                .collect(),
        ),
        Some(tag) => panic!("unknown fixture tag {tag}"),
        None => match value {
            Json::Array(v) => Value::Array(v.iter().map(encoded).collect()),
            Json::Object(v) => {
                Value::Object(v.iter().map(|(k, v)| (k.clone(), encoded(v))).collect())
            }
            _ => Value::from(value),
        },
    }
}

#[test]
fn node_number_and_rounding_contracts() {
    let fixtures = fixtures();
    for entry in fixtures["numberText"].as_array().unwrap() {
        assert_eq!(
            number_text(bits(&entry["bits"])),
            entry["text"].as_str().unwrap()
        );
    }
    for entry in fixtures["mathRound"].as_array().unwrap() {
        assert_eq!(
            js_round(bits(&entry["bits"])).to_bits(),
            bits(&entry["result"]).to_bits(),
            "{entry}"
        );
    }
    for entry in fixtures["toFixed"].as_array().unwrap() {
        assert_eq!(
            to_fixed(
                bits(&entry["bits"]),
                entry["digits"].as_u64().unwrap() as u8
            )
            .unwrap(),
            entry["text"].as_str().unwrap(),
            "{entry}"
        );
    }
}

#[test]
fn node_math_bits() {
    let fixtures = fixtures();
    let mut differences = Vec::new();
    for entry in fixtures["math"].as_array().unwrap() {
        let left = bits(&entry["left"]);
        let result = match entry["operation"].as_str().unwrap() {
            "exp" => js_exp(left),
            "log" => js_log(left),
            "pow" => js_pow(left, bits(&entry["right"])),
            _ => panic!("unknown operation"),
        };
        if result.to_bits() != bits(&entry["result"]).to_bits() {
            differences.push(format!("{entry} actual={:016x}", result.to_bits()));
        }
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

#[test]
fn node_json_and_hash_contracts() {
    let fixtures = fixtures();
    for entry in fixtures["canonicalJson"].as_array().unwrap() {
        let result = canonical_json(&encoded(&entry["encodedInput"]));
        if entry["throws"] == true {
            assert!(result.is_err(), "{entry}");
        } else {
            let text = result.unwrap();
            assert_eq!(text, entry["canonical"].as_str().unwrap(), "{entry}");
            assert_eq!(sha256(text.as_bytes()), entry["sha256"].as_str().unwrap());
        }
    }
    for entry in fixtures["stableDigest"].as_array().unwrap() {
        let value = encoded(&entry["encodedInput"]);
        let result = stable_json(&value);
        if entry["throws"] == true {
            assert!(result.is_err(), "{entry}");
        } else {
            assert_eq!(
                result.unwrap(),
                entry["stableJson"].as_str().unwrap(),
                "{entry}"
            );
            assert_eq!(
                stable_digest(&value).unwrap(),
                entry["digest"].as_str().unwrap()
            );
        }
    }
    for entry in fixtures["configHash"].as_array().unwrap() {
        assert_eq!(
            config_hash(&Value::from(&entry["input"])).unwrap(),
            entry["hash"].as_str().unwrap()
        );
    }
}

#[test]
fn node_semantic_artifact_contracts() {
    for entry in fixtures()["semanticArtifact"].as_array().unwrap() {
        let mut input = entry["input"].clone();
        if let Some(object) = input.as_object_mut() {
            for key in [
                "generatedAt",
                "artifactMeta",
                "schemaVersion",
                "modelVersion",
                "modelConfigHash",
            ] {
                object.remove(key);
            }
        }
        let envelope =
            json!({"artifactKind":"public-semantic-artifact", "schemaVersion":1, "content":input});
        let text = canonical_json(&Value::from(&envelope)).unwrap();
        assert_eq!(canonical_json_value(&envelope), text);
        assert_eq!(text, entry["canonical"].as_str().unwrap());
        assert_eq!(sha256(text.as_bytes()), entry["sha256"].as_str().unwrap());
        assert_eq!(text.len() as u64, entry["bytes"].as_u64().unwrap());
        let compressed = gzip(text.as_bytes()).unwrap();
        assert_eq!(compressed, gzip(text.as_bytes()).unwrap());
        assert_eq!(gunzip(&compressed).unwrap(), text.as_bytes());
        assert!(gunzip(b"invalid gzip").is_err());
    }
}

#[test]
fn borrowed_json_matches_node_canonical_bytes() {
    // Parse Node's expected canonical output to exercise plain JSON values without tags.
    for entry in fixtures()["canonicalJson"].as_array().unwrap() {
        if let Some(text) = entry["canonical"].as_str() {
            let value: Json = serde_json::from_str(text).unwrap();
            assert_eq!(canonical_json_value(&value), text, "{entry}");
        }
    }
}

#[test]
fn gzip_checks_all_members_and_checksums() {
    let mut joined = gzip(b"first").unwrap();
    joined.extend(gzip(b"second").unwrap());
    assert_eq!(gunzip(&joined).unwrap(), b"firstsecond");
    let mut corrupt = gzip(b"payload").unwrap();
    let checksum = corrupt.len() - 8;
    corrupt[checksum] ^= 1;
    assert!(gunzip(&corrupt).is_err());
    let mut truncated = gzip(b"payload").unwrap();
    truncated.pop();
    assert!(gunzip(&truncated).is_err());
}

#[test]
fn node_order_and_provider_time_contracts() {
    let fixtures = fixtures();
    let mut strings = fixtures["codeUnitOrder"]["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect::<Vec<_>>();
    strings.sort_by(|a, b| compare_code_units(a, b));
    assert_eq!(
        serde_json::to_value(strings).unwrap(),
        fixtures["codeUnitOrder"]["sorted"]
    );
    for entry in fixtures["providerTime"].as_array().unwrap() {
        let input = entry["input"].as_str().unwrap();
        assert_eq!(
            serde_json::to_value(provider_instant(input)).unwrap(),
            entry["instantMs"]
        );
        assert_eq!(provider_date(input), entry["date"].as_str().unwrap());
        assert_eq!(
            serde_json::to_value(provider_datetime_utc(input)).unwrap(),
            entry["datetimeUtc"]
        );
    }
}

#[test]
fn insertion_order_keeps_js_integer_keys_before_other_keys() {
    let input = json!({"z": 1, "2":"two", "10":"ten", "01":"one", "4294967295":false, "a":2});
    assert_eq!(
        js_json(&Value::from(&input)).unwrap(),
        "{\"2\":\"two\",\"10\":\"ten\",\"z\":1,\"01\":\"one\",\"4294967295\":false,\"a\":2}"
    );
}
