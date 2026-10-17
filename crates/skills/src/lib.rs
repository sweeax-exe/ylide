//! Agent Skills, in the open SKILL.md format: a folder with a `SKILL.md`
//! (YAML frontmatter with `name` and `description`, then Markdown
//! instructions) and optional files such as `references/*.md` or scripts.
//! Skills teach a task to any model, so they work with every model Ylide runs.
//!
//! * [`frontmatter`]: reads and checks `SKILL.md`.
//! * [`store`]: skills installed in Ylide's data folder, where each came from
//!   and whether it is on; skills of the open project are read in place.
//! * [`prompt`]: the short list of enabled skills for prompts, and reading a
//!   skill on demand (`skill_read`), bounded for small local contexts.
//! * [`github`]: repository addresses and git trees. The requests themselves
//!   are made by the app, through its network gate.
//!
//! Skills are instructions from third parties. Ylide never runs their
//! scripts: a model can only ask for one to run through the normal command
//! tool, under the user's approval mode.

pub mod frontmatter;
pub mod github;
pub mod prompt;
pub mod store;

pub use frontmatter::SkillMeta;
pub use prompt::EnabledSkill;
pub use store::{Project, SkillContent, SkillInfo, SkillSource, SkillStore, SkillUpdate};

#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error("SKILL.md must start with a frontmatter block between two '---' lines")]
    NoFrontmatter,
    #[error("line {0} of the frontmatter is not 'key: value'")]
    Syntax(usize),
    #[error("the frontmatter has no name")]
    MissingName,
    #[error("'{0}' is no valid skill name: use lowercase letters, digits and single hyphens, at most 64 characters")]
    InvalidName(String),
    #[error("the frontmatter has no description")]
    MissingDescription,
    #[error("the skill has no SKILL.md")]
    NoSkillFile,
    #[error("{0} is not a text file")]
    NotText(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("'{0}' is no safe path inside a skill")]
    UnsafePath(String),
    #[error("a skill called '{0}' is already installed")]
    Exists(String),
    #[error("there is no skill '{0}'")]
    NotFound(String),
    #[error("the new version is called '{new}' instead of '{old}'")]
    Renamed { old: String, new: String },
    #[error("{0}")]
    Address(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl SkillError {
    /// Stable code for the UI (translated there); the message carries the detail.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoFrontmatter
            | Self::Syntax(_)
            | Self::MissingName
            | Self::InvalidName(_)
            | Self::MissingDescription
            | Self::NoSkillFile
            | Self::NotText(_)
            | Self::UnsafePath(_) => "skill_invalid",
            Self::TooLarge(_) => "skill_too_large",
            Self::Exists(_) => "skill_exists",
            Self::NotFound(_) => "skill_not_found",
            Self::Renamed { .. } => "skill_renamed",
            Self::Address(_) => "skill_address",
            Self::Io(_) => "io",
        }
    }
}

pub type Result<T> = std::result::Result<T, SkillError>;
