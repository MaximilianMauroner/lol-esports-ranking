use ranking_contracts::{Result, sha256};
use reqwest::{Client, Method, Url};
use ring::hmac;
use std::{
    collections::BTreeMap,
    env,
    time::{Duration, SystemTime},
};

pub(super) use ranking_contracts::limits::{DOCUMENT_LIMIT, SEMANTIC_LIMIT, STORED_LIMIT};
pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct Transport {
    client: Client,
    endpoint: Url,
    bucket: String,
    region: String,
    access: String,
    secret: String,
    pub prefix: String,
    path_style: bool,
    pub redirect_threshold: Option<u64>,
}

pub(super) struct Object {
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy)]
pub(super) enum ReadMethod {
    Get,
    Head,
}
impl ReadMethod {
    fn method(self) -> Method {
        match self {
            Self::Get => Method::GET,
            Self::Head => Method::HEAD,
        }
    }
}

impl Transport {
    pub fn from_env() -> Result<Option<Self>> {
        Self::from_values(|name| env::var(name).ok())
    }

    #[cfg(test)]
    pub(super) fn fixture(endpoint: &str, redirect: bool) -> Self {
        let values = BTreeMap::from([
            ("BUCKET", "fixture"),
            ("ENDPOINT", endpoint),
            ("ACCESS_KEY_ID", "read-only"),
            ("SECRET_ACCESS_KEY", "fixture-secret"),
            ("RANKING_BUCKET_FORCE_PATH_STYLE", "true"),
            (
                "RANKING_PRESIGNED_DELIVERY_ENABLED",
                if redirect { "true" } else { "false" },
            ),
            ("RANKING_PRESIGNED_DELIVERY_THRESHOLD_BYTES", "1"),
        ]);
        Self::from_values(|name| values.get(name).map(|value| value.to_string()))
            .unwrap()
            .unwrap()
    }

    fn from_values(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>> {
        let first = |keys: &[&str]| keys.iter().find_map(|key| get(key));
        let bucket = first(&["RANKING_BUCKET_NAME", "S3_BUCKET", "BUCKET"]);
        let endpoint = first(&["RANKING_BUCKET_ENDPOINT", "S3_ENDPOINT", "ENDPOINT"]);
        let access = first(&[
            "RANKING_BUCKET_ACCESS_KEY_ID",
            "AWS_ACCESS_KEY_ID",
            "ACCESS_KEY_ID",
        ]);
        let secret = first(&[
            "RANKING_BUCKET_SECRET_ACCESS_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "SECRET_ACCESS_KEY",
        ]);
        if [&bucket, &endpoint, &access, &secret]
            .iter()
            .any(|value| value.as_ref().is_none_or(String::is_empty))
        {
            return Ok(None);
        }
        let endpoint = Url::parse(&endpoint.unwrap()).map_err(|_| "Invalid S3 endpoint")?;
        if !matches!(endpoint.scheme(), "https" | "http")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("Invalid S3 endpoint".into());
        }
        let prefix = get("RANKING_BUCKET_PREFIX")
            .unwrap_or_else(|| "rankings".into())
            .trim_matches('/')
            .to_owned();
        if !prefix.is_empty() {
            super::super::s3::validate_key(&prefix)?;
        }
        let redirect_threshold =
            (get("RANKING_PRESIGNED_DELIVERY_ENABLED").as_deref() == Some("true")).then(|| {
                get("RANKING_PRESIGNED_DELIVERY_THRESHOLD_BYTES")
                    .and_then(|value| {
                        ranking_contracts::published::serving::positive_number_text(&value)
                    })
                    .unwrap_or(65_536)
            });
        Ok(Some(Self {
            client: Client::builder()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .connect_timeout(Duration::from_secs(10))
                .timeout(READ_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .pool_max_idle_per_host(2)
                .build()
                .map_err(|_| "Cannot create read-only S3 client")?,
            endpoint,
            bucket: bucket.unwrap(),
            access: access.unwrap(),
            secret: secret.unwrap(),
            prefix,
            region: first(&[
                "RANKING_BUCKET_REGION",
                "AWS_REGION",
                "AWS_DEFAULT_REGION",
                "S3_REGION",
                "REGION",
            ])
            .unwrap_or_else(|| "auto".into()),
            path_style: get("RANKING_BUCKET_FORCE_PATH_STYLE")
                .is_some_and(|value| value == "true" || value == "1"),
            redirect_threshold,
        }))
    }

    fn url(&self, key: &str) -> Result<Url> {
        super::super::s3::validate_key(key)?;
        let key = if self.prefix.is_empty() {
            key.to_owned()
        } else {
            format!("{}/{key}", self.prefix)
        };
        let mut url = self.endpoint.clone();
        let base = url.path().trim_end_matches('/').to_owned();
        if self.path_style {
            url.set_path(&format!(
                "{base}/{}/{}",
                encode(&self.bucket, false),
                encode(&key, true)
            ));
        } else {
            let host = format!(
                "{}.{}",
                self.bucket,
                url.host_str().ok_or("S3 endpoint lacks host")?
            );
            url.set_host(Some(&host))
                .map_err(|_| "Invalid S3 bucket host")?;
            url.set_path(&format!("{base}/{}", encode(&key, true)));
        }
        Ok(url)
    }

    pub async fn read(&self, key: &str, method: ReadMethod, limit: u64) -> Result<Option<Object>> {
        let url = self.url(key)?;
        let (stamp, day) = timestamp();
        let payload_hash = sha256(&[]);
        let host = host(&url)?;
        let canonical_headers =
            format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{stamp}\n");
        let signed = "host;x-amz-content-sha256;x-amz-date";
        let canonical = format!(
            "{}\n{}\n\n{canonical_headers}\n{signed}\n{payload_hash}",
            method.method(),
            url.path()
        );
        let (scope, signature) = self.signature(&day, &stamp, &canonical);
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={signature}",
            self.access
        );
        let mut response = self
            .client
            .request(method.method(), url)
            .header("host", host)
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", stamp)
            .header("authorization", authorization)
            .send()
            .await
            .map_err(|_| "S3 read-only transport failed")?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if response.status().as_u16() != 200 {
            return Err(format!(
                "S3 read failed with HTTP {}",
                response.status().as_u16()
            ));
        }
        if response
            .headers()
            .iter()
            .map(|(key, value)| key.as_str().len() + value.as_bytes().len())
            .sum::<usize>()
            > 65_536
        {
            return Err("S3 response metadata exceeds serving limit".into());
        }
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                let value = value.to_str().map_err(|_| "Invalid S3 response metadata")?;
                if value.len() > 8192 || value.chars().any(char::is_control) {
                    return Err("Unsafe S3 response metadata".to_owned());
                }
                Ok((name.as_str().to_owned(), value.to_owned()))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let length = headers
            .get("content-length")
            .map(|value| value.parse::<u64>().map_err(|_| "Invalid S3 object length"))
            .transpose()?;
        if matches!(method, ReadMethod::Head) {
            return Ok(Some(Object {
                headers,
                body: Vec::new(),
            }));
        }
        if length.is_some_and(|length| length > limit) {
            return Err("S3 stored object exceeds serving limit".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "S3 response body failed")?
        {
            if body.len() as u64 + chunk.len() as u64 > limit {
                return Err("S3 stored object exceeds serving limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        if length.is_some_and(|length| length != body.len() as u64) {
            return Err("S3 stored object length mismatch".into());
        }
        Ok(Some(Object { headers, body }))
    }

    pub fn presign(&self, key: &str, method: ReadMethod) -> Result<String> {
        self.presign_at(key, method, timestamp())
    }

    fn presign_at(
        &self,
        key: &str,
        method: ReadMethod,
        (stamp, day): (String, String),
    ) -> Result<String> {
        let mut url = self.url(key)?;
        let scope = format!("{day}/{}/s3/aws4_request", self.region);
        let query = BTreeMap::from([
            ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_owned()),
            ("X-Amz-Credential", format!("{}/{scope}", self.access)),
            ("X-Amz-Date", stamp.clone()),
            ("X-Amz-Expires", "3600".to_owned()),
            ("X-Amz-SignedHeaders", "host".to_owned()),
        ])
        .into_iter()
        .map(|(key, value)| format!("{key}={}", encode(&value, false)))
        .collect::<Vec<_>>()
        .join("&");
        let canonical = format!(
            "{}\n{}\n{query}\nhost:{}\n\nhost\nUNSIGNED-PAYLOAD",
            method.method(),
            url.path(),
            host(&url)?
        );
        let (_, signature) = self.signature(&day, &stamp, &canonical);
        url.set_query(Some(&format!("{query}&X-Amz-Signature={signature}")));
        Ok(url.into())
    }

    fn signature(&self, day: &str, stamp: &str, canonical: &str) -> (String, String) {
        let scope = format!("{day}/{}/s3/aws4_request", self.region);
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}",
            sha256(canonical.as_bytes())
        );
        let date_key = sign(format!("AWS4{}", self.secret).as_bytes(), day.as_bytes());
        let region_key = sign(&date_key, self.region.as_bytes());
        let service_key = sign(&region_key, b"s3");
        let key = sign(&service_key, b"aws4_request");
        let signature = sign(&key, to_sign.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        (scope, signature)
    }
}

fn timestamp() -> (String, String) {
    let time = chrono::DateTime::<chrono::Utc>::from(SystemTime::now());
    (
        time.format("%Y%m%dT%H%M%SZ").to_string(),
        time.format("%Y%m%d").to_string(),
    )
}
fn host(url: &Url) -> Result<String> {
    let host = url.host_str().ok_or("S3 endpoint lacks host")?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}
fn sign(key: &[u8], value: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), value)
        .as_ref()
        .to_vec()
}
fn encode(text: &str, slash: bool) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) || (slash && byte == b'/') {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(extra: &[(&str, &str)]) -> Result<Option<Transport>> {
        let mut values = BTreeMap::from([
            ("BUCKET", "test-bucket"),
            ("ENDPOINT", "http://127.0.0.1:9000"),
            ("ACCESS_KEY_ID", "read-only"),
            ("SECRET_ACCESS_KEY", "test-secret"),
            ("RANKING_BUCKET_FORCE_PATH_STYLE", "true"),
        ]);
        values.extend(extra.iter().copied());
        Transport::from_values(|name| values.get(name).map(|value| value.to_string()))
    }
    #[test]
    fn incomplete_config_disables_before_endpoint_parsing_and_empty_alias_wins() {
        assert!(
            Transport::from_values(|name| (name == "ENDPOINT").then(|| "bad".into()))
                .unwrap()
                .is_none()
        );
        assert!(config(&[("RANKING_BUCKET_NAME", "")]).unwrap().is_none());
        assert!(config(&[("RANKING_BUCKET_ENDPOINT", "bad")]).is_err());
    }
    #[test]
    fn presigning_binds_method_expiry_path_and_authority() {
        let transport = config(&[("RANKING_BUCKET_PREFIX", "/corpus/")])
            .unwrap()
            .unwrap();
        let time = ("20261019T120000Z".into(), "20261019".into());
        let path = format!("objects/sha256/{}", "a".repeat(64));
        let get = transport
            .presign_at(&path, ReadMethod::Get, time.clone())
            .unwrap();
        let head = transport.presign_at(&path, ReadMethod::Head, time).unwrap();
        assert!(get.contains("/test-bucket/corpus/objects/sha256/"));
        assert!(get.contains("X-Amz-Expires=3600"));
        assert!(get.contains("X-Amz-Credential=read-only%2F20261019%2Fauto%2Fs3%2Faws4_request"));
        assert_ne!(get, head);
        assert!(transport.presign("../escape", ReadMethod::Get).is_err());
        assert!(!get.contains("test-secret"));
    }
}
