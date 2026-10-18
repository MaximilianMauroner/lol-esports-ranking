use crate::Result;

pub fn validate_storage_key(key: &str) -> Result<()> {
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
