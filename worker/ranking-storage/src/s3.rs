use ranking_contracts::limits::STORED_LIMIT;
use ranking_contracts::{Result, sha256};
use reqwest::{Method, Url, blocking::Client};
use ring::hmac;
use std::{collections::BTreeMap, env, io::Read, time::Duration};

pub struct Bucket {
    client: Client,
    request_timeout: Duration,
    endpoint: Url,
    bucket: String,
    region: String,
    access: String,
    secret: String,
    pub prefix: String,
    path_style: bool,
}

pub struct Object {
    pub status: u16,
    pub etag: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl Bucket {
    pub fn from_env() -> Result<Self> {
        let endpoint = required(&["RANKING_BUCKET_ENDPOINT", "S3_ENDPOINT", "ENDPOINT"])?;
        let endpoint = Url::parse(&endpoint).map_err(|_| "Invalid S3 endpoint")?;
        if !matches!(endpoint.scheme(), "https" | "http")
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err("S3 endpoint must be an HTTP origin".into());
        }
        let prefix = env::var("RANKING_BUCKET_PREFIX").unwrap_or_else(|_| "rankings".into());
        let prefix = prefix.trim_matches('/').to_owned();
        if !prefix.is_empty() {
            validate_key(&prefix)?;
        }
        Ok(Self {
            client: Client::builder()
                // Other workspace crates enable reqwest decoders. S3 identity
                // checks need the original object bytes and encoding headers.
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .timeout(Duration::from_secs(120))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Cannot create S3 client")?,
            request_timeout: Duration::from_secs(120),
            endpoint,
            bucket: required(&["RANKING_BUCKET_NAME", "S3_BUCKET", "BUCKET"])?,
            region: optional(&[
                "RANKING_BUCKET_REGION",
                "AWS_REGION",
                "AWS_DEFAULT_REGION",
                "S3_REGION",
                "REGION",
            ])
            .unwrap_or_else(|| "auto".into()),
            access: required(&[
                "RANKING_BUCKET_ACCESS_KEY_ID",
                "AWS_ACCESS_KEY_ID",
                "ACCESS_KEY_ID",
            ])?,
            secret: required(&[
                "RANKING_BUCKET_SECRET_ACCESS_KEY",
                "AWS_SECRET_ACCESS_KEY",
                "SECRET_ACCESS_KEY",
            ])?,
            prefix,
            path_style: env::var("RANKING_BUCKET_FORCE_PATH_STYLE")
                .is_ok_and(|v| v == "true" || v == "1"),
        })
    }

    pub fn request(
        &self,
        method: Method,
        key: &str,
        mut headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> Result<Object> {
        validate_key(key)?;
        let key = if self.prefix.is_empty() {
            key.to_owned()
        } else {
            format!("{}/{key}", self.prefix)
        };
        let mut url = self.endpoint.clone();
        let path = if self.path_style {
            format!("/{}/{}", encode(&self.bucket, false), encode(&key, true))
        } else {
            let host = format!(
                "{}.{}",
                self.bucket,
                url.host_str().ok_or("S3 endpoint lacks host")?
            );
            url.set_host(Some(&host))
                .map_err(|_| "Invalid S3 bucket host")?;
            format!("/{}", encode(&key, true))
        };
        url.set_path(&path);
        let time = chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now());
        let stamp = time.format("%Y%m%dT%H%M%SZ").to_string();
        let day = time.format("%Y%m%d").to_string();
        let host = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().ok_or("S3 endpoint lacks host")?),
            None => url.host_str().ok_or("S3 endpoint lacks host")?.to_owned(),
        };
        headers.insert("host".into(), host);
        headers.insert("x-amz-content-sha256".into(), sha256(&body));
        headers.insert("x-amz-date".into(), stamp.clone());
        let signed = headers.keys().cloned().collect::<Vec<_>>().join(";");
        let canonical_headers = headers
            .iter()
            .map(|(key, value)| {
                format!(
                    "{key}:{}\n",
                    value.split_whitespace().collect::<Vec<_>>().join(" ")
                )
            })
            .collect::<String>();
        let canonical = format!(
            "{}\n{}\n\n{}\n{}\n{}",
            method.as_str(),
            url.path(),
            canonical_headers,
            signed,
            sha256(&body)
        );
        let scope = format!("{day}/{}/s3/aws4_request", self.region);
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}",
            sha256(canonical.as_bytes())
        );
        let date_key = sign(format!("AWS4{}", self.secret).as_bytes(), day.as_bytes());
        let region_key = sign(&date_key, self.region.as_bytes());
        let service_key = sign(&region_key, b"s3");
        let signing_key = sign(&service_key, b"aws4_request");
        let signature = sign(&signing_key, to_sign.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        headers.insert("authorization".into(), format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={signature}", self.access));
        let head = method == Method::HEAD;
        let mut request = self.client.request(method, url).body(body);
        for (key, value) in headers {
            request = request.header(key, value);
        }
        // Never emit reqwest's URL-bearing error: signed requests and credentials stay private.
        let mut response = request.send().map_err(|_| "S3 transport request failed")?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(key, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (key.as_str().to_owned(), v.to_owned()))
            })
            .collect::<BTreeMap<_, _>>();
        let etag = headers.get("etag").cloned().unwrap_or_default();
        if !head
            && response
                .content_length()
                .is_some_and(|length| length > STORED_LIMIT)
        {
            return Err("S3 stored object exceeds byte limit".into());
        }
        let mut body = Vec::new();
        let mut buffer = [0; 65_536];
        loop {
            let count = response
                .read(&mut buffer)
                .map_err(|_| "S3 response body failed")?;
            if count == 0 {
                break;
            }
            if body.len() as u64 + count as u64 > STORED_LIMIT {
                return Err("S3 stored object exceeds byte limit".into());
            }
            body.extend_from_slice(&buffer[..count]);
        }
        Ok(Object {
            status,
            etag,
            headers,
            body,
        })
    }
}

pub fn validate_key(key: &str) -> Result<()> {
    if key.starts_with('/')
        || key.ends_with('/')
        || key.contains('\\')
        || key
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || key.chars().any(char::is_control)
    {
        return Err("Invalid relative S3 key".into());
    }
    Ok(())
}

fn sign(key: &[u8], value: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), value)
        .as_ref()
        .to_vec()
}

fn encode(text: &str, preserve_slash: bool) -> String {
    let mut result = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || b"-._~".contains(&byte)
            || (preserve_slash && byte == b'/')
        {
            result.push(char::from(byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn optional(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| env::var(key).ok())
}
fn required(keys: &[&str]) -> Result<String> {
    optional(keys)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {}", keys[0]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ranking_contracts::limits::STORED_LIMIT;
    use std::io::{Read, Write};

    fn serve(headers: &str, body: Vec<u8>) -> (Bucket, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let headers = headers.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let _ = stream.write_all(
                format!("HTTP/1.1 200 OK\r\nConnection: close\r\n{headers}\r\n").as_bytes(),
            );
            let _ = stream.write_all(&body);
        });
        let bucket = Bucket {
            client: Client::builder()
                .no_proxy()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .build()
                .unwrap(),
            request_timeout: Duration::from_secs(120),
            endpoint,
            bucket: "fixture".into(),
            region: "auto".into(),
            access: "fixture-access".into(),
            secret: "fixture-secret".into(),
            prefix: "rankings".into(),
            path_style: true,
        };
        (bucket, server)
    }

    #[test]
    fn s3_body_reads_keep_the_total_request_deadline() {
        let timeout = Duration::from_millis(250);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream.set_nodelay(true).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 20\r\n\r\n")
                .unwrap();
            for _ in 0..20 {
                if stream.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let bucket = Bucket {
            client: Client::builder()
                .no_proxy()
                .timeout(timeout)
                .build()
                .unwrap(),
            request_timeout: timeout,
            endpoint,
            bucket: "fixture".into(),
            region: "auto".into(),
            access: "fixture-access".into(),
            secret: "fixture-secret".into(),
            prefix: "rankings".into(),
            path_style: true,
        };
        let result = bucket.request(Method::GET, "objects/fixture", BTreeMap::new(), vec![]);
        server.join().unwrap();
        let error = result
            .err()
            .expect("S3 body exceeded the total request deadline");
        assert_eq!(error, "S3 response body failed");
    }

    #[test]
    fn s3_http_bodies_are_bounded() {
        let oversized = vec![b'x'; STORED_LIMIT as usize + 1];
        let chunked = [
            format!("{:x}\r\n", oversized.len()).into_bytes(),
            oversized.clone(),
            b"\r\n0\r\n\r\n".to_vec(),
        ]
        .concat();
        for (headers, body) in [
            ("Transfer-Encoding: chunked\r\n".to_owned(), chunked),
            (
                format!("Content-Length: {}\r\n", oversized.len()),
                Vec::new(),
            ),
            (String::new(), oversized),
        ] {
            let (bucket, server) = serve(&headers, body);
            let result = bucket.request(Method::GET, "objects/fixture", BTreeMap::new(), vec![]);
            server.join().unwrap();
            let error = result.err().expect("oversized S3 body was accepted");
            assert!(error.contains("limit"), "{error}");
            assert!(!error.contains("fixture-secret"));
        }
    }

    #[test]
    fn s3_http_accepts_the_exact_stored_limit() {
        let body = vec![b'x'; STORED_LIMIT as usize];
        let (bucket, server) = serve(&format!("Content-Length: {}\r\n", body.len()), body.clone());
        let response = bucket
            .request(Method::GET, "objects/fixture", BTreeMap::new(), vec![])
            .unwrap();
        server.join().unwrap();
        assert_eq!(response.body, body);
    }

    #[test]
    fn s3_head_preserves_lengths_larger_than_the_body_limit() {
        let size = STORED_LIMIT + 1;
        let (bucket, server) = serve(&format!("Content-Length: {size}\r\n"), Vec::new());
        let response = bucket
            .request(Method::HEAD, "objects/fixture", BTreeMap::new(), vec![])
            .unwrap();
        server.join().unwrap();
        assert!(response.body.is_empty());
        assert_eq!(
            response.headers.get("content-length"),
            Some(&size.to_string())
        );
    }

    #[test]
    fn object_paths_stay_in_the_selected_prefix() {
        for key in [
            "/raw/a", "raw/../a", "raw//a", "raw\\a", "raw/./a", "raw/a\n",
        ] {
            assert!(validate_key(key).is_err());
        }
        assert!(validate_key("raw/objects/sha256/abc").is_ok());
        assert_eq!(encode("a/é +", true), "a/%C3%A9%20%2B");
    }
}
