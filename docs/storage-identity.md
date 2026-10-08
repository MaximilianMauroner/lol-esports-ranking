# Stored object identity

Public, raw-source, and incremental-state objects use the SHA-256 digest of their canonical JSON bytes as the object key. The semantic byte count is checked with the digest. Gzip bytes and gzip size can differ between Node, Rust, and compressor versions without changing that identity.

New raw-source receipts and state manifests omit `compressedBytes` from nested object references. Preparation also removes that legacy field from reused references before computing new receipt and manifest identities. This causes the approved one-time change to raw identity, source receipt identity, and state manifest digests. Existing objects do not need a data rewrite.

Readers still accept stored raw receipts and state manifests that contain `compressedBytes`. They preserve that field when parsing, so existing canonical bytes and receipt digests remain valid. They enforce its declared size when reading the legacy object. This compatibility is in `raw-source-storage.mjs`, `incremental-state-storage.mjs`, and the source-authority, full-audit, and restart-baseline readers. Remove it only when no active, rollback, audit, or recovery authority refers to the old format.

Reuse checks decompress the actual stored payload and verify its semantic size and digest, gzip integrity, metadata, and received size against storage `ContentLength`. They do not compare stored compression with newly prepared compression. Raw and JSON state reads also enforce canonical JSON. Publication receipts, active pointer transport fields, upload descriptors, and audit snapshot descriptors retain measured transport sizes. These measurements describe the stored object, not a compressor-independent semantic identity. State publication closure sizes come from independent payload verification and must match reported outcomes before activation.

No public ranking, model, bucket namespace, or production data is changed by this prerequisite. The new Node worker can read old receipts; an old worker cannot read the new reference format. Do not roll back code alone after publishing new-format authorities without restoring a compatible prior generation.
