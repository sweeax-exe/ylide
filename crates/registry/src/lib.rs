//! The model registry: a versioned JSON document (`registry/models.json` in the
//! repository) describing downloadable models and runtimes, plus the logic that
//! turns a [`hardware::HardwareProfile`] into a recommendation.
//!
//! Network access is deliberately *not* part of this crate. The app fetches the
//! remote copy through its network gate and hands the text to [`parse`].

pub mod estimate;
pub mod recommend;
pub mod schema;
pub mod store;

pub use recommend::{Alternative, AlternativeKind, Candidate, Reason, ReasonCode, Recommendation, recommend};
pub use schema::*;

use std::collections::HashSet;

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("registry is not valid JSON for this schema: {0}")]
    Json(#[from] serde_json::Error),
    #[error("registry schema version {found} is newer than supported version {supported}")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("registry failed validation: {0}")]
    Invalid(String),
    #[error("registry cache I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

/// The registry compiled into the binary; used offline and as the fallback.
pub const BUNDLED_JSON: &str = include_str!("../../../registry/models.json");

/// Parses and validates the bundled registry. Panics only if the repository
/// ships a broken file, which `tests::bundled_registry_is_valid` prevents.
pub fn bundled() -> Registry {
    parse(BUNDLED_JSON).expect("bundled registry must be valid")
}

/// Parses registry JSON, rejecting unknown schema versions and invalid data.
pub fn parse(json: &str) -> Result<Registry, RegistryError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Header {
        schema_version: u32,
    }
    let header: Header = serde_json::from_str(json)?;
    if header.schema_version > SCHEMA_VERSION {
        return Err(RegistryError::UnsupportedSchema {
            found: header.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    let registry: Registry = serde_json::from_str(json)?;
    validate(&registry)?;
    Ok(registry)
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A downloadable file: known size, hash, and a path that stays inside the repository folder.
fn check_file(model: &str, part: &str, f: &ModelFile) -> Result<(), RegistryError> {
    if f.size_bytes == 0 || !is_sha256(&f.sha256) {
        return Err(RegistryError::Invalid(format!("{model}/{part}: file '{}' needs size and lower-case sha256", f.path)));
    }
    if f.path.contains("..") || f.path.starts_with('/') {
        return Err(RegistryError::Invalid(format!("{model}/{part}: unsafe path '{}'", f.path)));
    }
    Ok(())
}

/// Semantic checks that JSON Schema cannot express (uniqueness, consistency).
pub fn validate(registry: &Registry) -> Result<(), RegistryError> {
    let fail = |msg: String| Err(RegistryError::Invalid(msg));
    let mut ids = HashSet::new();
    for m in &registry.models {
        if !ids.insert(m.id.as_str()) {
            return fail(format!("duplicate model id '{}'", m.id));
        }
        if m.roles.is_empty() {
            return fail(format!("{}: no roles", m.id));
        }
        if m.variants.is_empty() {
            return fail(format!("{}: no variants", m.id));
        }
        if m.has_role(Role::Fim) && m.fim.is_none() {
            return fail(format!("{}: role 'fim' requires a fim format", m.id));
        }
        if m.has_role(Role::Embedding) && m.embedding.is_none() {
            return fail(format!("{}: role 'embedding' requires embedding info", m.id));
        }
        if m.uncensored && registry.schema_version < 2 {
            return fail(format!("{}: uncensored models need schema version 2", m.id));
        }
        if m.context.recommended > m.context.max {
            return fail(format!("{}: recommended context exceeds max", m.id));
        }
        let a = &m.architecture;
        if a.params_active_b > a.params_total_b || a.layers == 0 || a.params_total_b <= 0.0 {
            return fail(format!("{}: inconsistent architecture", m.id));
        }
        for q in [m.quality.coding, m.quality.agentic] {
            if !(0.0..=100.0).contains(&q) {
                return fail(format!("{}: quality must be within 0..100", m.id));
            }
        }
        for v in &m.variants {
            if v.files.is_empty() {
                return fail(format!("{}/{}: no files", m.id, v.quant));
            }
            for f in &v.files {
                check_file(&m.id, &v.quant, f)?;
            }
        }
        // An app that sees `vision` offers image input, which needs the projector.
        match (&m.projector, m.capabilities.vision) {
            (Some(p), true) => check_file(&m.id, "projector", p)?,
            (None, false) => {}
            (Some(_), false) => return fail(format!("{}: a projector needs capabilities.vision", m.id)),
            (None, true) => return fail(format!("{}: capabilities.vision needs a projector", m.id)),
        }
    }
    for rt in &registry.runtimes {
        for asset in &rt.assets {
            for f in &asset.files {
                if !is_sha256(&f.sha256) || !f.url.starts_with("https://") {
                    return fail(format!("runtime {} {}: files need https url and sha256", rt.id, asset.variant));
                }
            }
        }
    }
    Ok(())
}

/// Compares calendar versions like "2026.10.15" (also accepts "2026.10.15.1").
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(candidate) > parse(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_is_valid() {
        let r = bundled();
        assert_eq!(r.schema_version, SCHEMA_VERSION);
        assert!(r.models.iter().any(|m| m.has_role(Role::Agent)));
        assert!(r.models.iter().any(|m| m.has_role(Role::Fim)));
        assert!(r.models.iter().any(|m| m.has_role(Role::Embedding)));
    }

    #[test]
    fn bundled_registry_matches_json_schema() {
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../../../registry/schema/registry.schema.json")).unwrap();
        let instance: serde_json::Value = serde_json::from_str(BUNDLED_JSON).unwrap();
        let validator = jsonschema::validator_for(&schema).expect("schema compiles");
        let errors: Vec<String> = validator.iter_errors(&instance).map(|e| format!("{} at {}", e, e.instance_path())).collect();
        assert!(errors.is_empty(), "{errors:#?}");
    }

    #[test]
    fn rejects_future_schema() {
        let json = r#"{"schemaVersion": 99, "registryVersion": "1", "updatedAt": "", "models": []}"#;
        assert!(matches!(parse(json), Err(RegistryError::UnsupportedSchema { found: 99, .. })));
    }

    #[test]
    fn rejects_duplicate_ids_and_bad_hashes() {
        let mut r = bundled();
        let dup = r.models[0].clone();
        r.models.push(dup);
        assert!(validate(&r).is_err());

        let mut r = bundled();
        r.models[0].variants[0].files[0].sha256 = "ABC".into();
        assert!(validate(&r).is_err());

        let mut r = bundled();
        r.models[0].variants[0].files[0].path = "../evil.gguf".into();
        assert!(validate(&r).is_err());
    }

    #[test]
    fn uncensored_models_need_schema_version_two() {
        let mut r = bundled();
        r.models[0].uncensored = true;
        assert!(validate(&r).is_ok());
        r.schema_version = 1;
        assert!(validate(&r).is_err(), "an app that predates the flag would recommend it");
    }

    #[test]
    fn vision_and_projector_come_together() {
        let r = bundled();
        let seeing: Vec<&Model> = r.models.iter().filter(|m| m.capabilities.vision).collect();
        assert!(seeing.iter().any(|m| m.id == "qwen3.6-35b-a3b"), "the default model can see images");
        for m in &seeing {
            let p = m.projector.as_ref().unwrap();
            assert!(p.path.contains("mmproj") && p.size_bytes > 100 << 20, "{}: {}", m.id, p.path);
        }
        assert!(r.models.iter().filter(|m| m.has_role(Role::Fim) || m.has_role(Role::Embedding)).all(|m| m.projector.is_none()));

        let id = seeing[0].id.clone();
        let with = |change: &dyn Fn(&mut Model)| {
            let mut r = bundled();
            change(r.models.iter_mut().find(|m| m.id == id).unwrap());
            validate(&r)
        };
        assert!(with(&|_| {}).is_ok());
        assert!(with(&|m| m.projector = None).is_err(), "vision without a projector");
        assert!(with(&|m| m.capabilities.vision = false).is_err(), "a projector without vision");
        assert!(with(&|m| m.projector.as_mut().unwrap().sha256.clear()).is_err());
        assert!(with(&|m| m.projector.as_mut().unwrap().path = "../mmproj.gguf".into()).is_err());
        assert!(with(&|m| {
            m.projector = None;
            m.capabilities.vision = false;
        })
        .is_ok());
    }

    /// Ylide 0.1.4 and 0.1.5 read the same v2 list without knowing `projector`:
    /// serde skips unknown fields (no type here denies them), so a list with
    /// fields from a later version still parses.
    #[test]
    fn unknown_fields_are_ignored() {
        let mut json: serde_json::Value = serde_json::from_str(BUNDLED_JSON).unwrap();
        json["futureTopLevel"] = serde_json::json!(true);
        for m in json["models"].as_array_mut().unwrap() {
            m["futureField"] = serde_json::json!({"any": "thing"});
            m["capabilities"]["futureCapability"] = serde_json::json!(1);
            m["variants"][0]["futureVariantField"] = serde_json::json!([]);
        }
        let parsed = parse(&json.to_string()).unwrap();
        assert_eq!(parsed, bundled());
        // The list as 0.1.5 sees it: without the projector and with `vision` (which 0.1.5 never reads).
        for m in json["models"].as_array_mut().unwrap() {
            m.as_object_mut().unwrap().remove("projector");
            m["capabilities"]["vision"] = serde_json::json!(false);
        }
        assert!(parse(&json.to_string()).unwrap().models.iter().all(|m| m.projector.is_none()));
    }

    #[test]
    fn calendar_version_ordering() {
        assert!(is_newer("2026.10.16", "2026.10.15"));
        assert!(is_newer("2026.11.1", "2026.10.31"));
        assert!(is_newer("2026.10.15.1", "2026.10.15"));
        assert!(!is_newer("2026.10.15", "2026.10.15"));
        assert!(!is_newer("2026.9.30", "2026.10.1"));
    }
}
