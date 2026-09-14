use crate::contracts::{DocEntry, Document, Project};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::Instant,
};

pub type Result<T> = std::result::Result<T, String>;

pub fn io(error: std::io::Error) -> String {
    format!("IO_ERROR: {error}")
}

pub fn tasks_root(project: &Project) -> Result<PathBuf> {
    // Explicit .trellis/tasks root links are accepted. Descendants cannot escape it.
    Path::new(&project.path)
        .join(".trellis/tasks")
        .canonicalize()
        .map_err(io)
}

pub fn safe_relative(value: &str) -> Result<&Path> {
    let path = Path::new(value);
    if value.is_empty()
        || path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("ACCESS_DENIED: invalid relative path".into());
    }
    Ok(path)
}

pub fn contained(root: &Path, relative: &str) -> Result<PathBuf> {
    let candidate = root
        .join(safe_relative(relative)?)
        .canonicalize()
        .map_err(io)?;
    if !candidate.starts_with(root) {
        return Err("ACCESS_DENIED: path escapes registered root".into());
    }
    Ok(candidate)
}

pub fn document_tree(task: &Path) -> Result<Vec<DocEntry>> {
    fn walk(
        root: &Path,
        path: &Path,
        out: &mut Vec<DocEntry>,
        seen: &mut std::collections::HashSet<PathBuf>,
    ) -> Result<()> {
        let actual = path.canonicalize().map_err(io)?;
        if !actual.starts_with(root) || !seen.insert(actual) {
            return Ok(());
        }
        for entry in fs::read_dir(path).map_err(io)? {
            let entry = entry.map_err(io)?;
            let path = entry.path();
            let actual = match path.canonicalize() {
                Ok(p) if p.starts_with(root) => p,
                _ => continue,
            };
            if actual.is_dir() {
                walk(root, &path, out, seen)?;
            } else if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            {
                let key = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                out.push(DocEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: key.clone(),
                    key,
                });
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(task, task, &mut out, &mut Default::default())?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub fn read_document(task: &Path, task_key: String, key: String) -> Result<Document> {
    let start = Instant::now();
    let path = contained(task, &key)?;
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return Err("ACCESS_DENIED: only Markdown documents may be read".into());
    }
    let bytes = fs::read(path).map_err(io)?;
    let revision = blake3::hash(&bytes).to_hex().to_string();
    let content = String::from_utf8(bytes)
        .map_err(|_| "UNSUPPORTED_ENCODING: document must be UTF-8".to_string())?;
    Ok(Document {
        task_key,
        key,
        content,
        revision,
        read_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_escaping_symlink_without_writes() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "private").unwrap();
        fs::write(dir.path().join("prd.md"), "hello").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("outside")).unwrap();
        assert!(contained(&dir.path().canonicalize().unwrap(), "../secret.md").is_err());
        assert!(contained(&dir.path().canonicalize().unwrap(), "outside/secret.md").is_err());
        assert!(contained(&dir.path().canonicalize().unwrap(), "/etc/passwd").is_err());
        let before = fs::metadata(dir.path().join("prd.md"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            document_tree(&dir.path().canonicalize().unwrap())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            read_document(
                &dir.path().canonicalize().unwrap(),
                "task".into(),
                "prd.md".into()
            )
            .unwrap()
            .content,
            "hello"
        );
        assert_eq!(
            fs::metadata(dir.path().join("prd.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
    }
    #[test]
    fn enumerates_deep_documents_without_twenty_four_limit() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("research/deep")).unwrap();
        for i in 0..40 {
            fs::write(dir.path().join(format!("research/deep/{i}.md")), "x").unwrap();
        }
        assert_eq!(
            document_tree(&dir.path().canonicalize().unwrap())
                .unwrap()
                .len(),
            40
        );
    }
}
