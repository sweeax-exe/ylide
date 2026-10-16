//! Long-term project knowledge in `AGENTS.md` in the project root.
//!
//! The file belongs to the user. Ylide keeps its own notes in one marked
//! section and never changes anything outside it; text the user wrote there
//! counts as rules for the agents. Every run reads the whole file (bounded,
//! local models have small contexts). After a run the orchestrator rewrites
//! the Ylide section with what it learned, through the normal tool path, so
//! the write asks first in "ask" mode and can be undone from its checkpoint.
//!
//! This is separate from the short-term record of the last run that
//! "Continue" uses: that one lives in the app's data folder, not the project.

/// Path of the file, relative to the project root.
pub const FILE: &str = "AGENTS.md";
pub const START: &str = "<!-- ylide:start -->";
pub const END: &str = "<!-- ylide:end -->";
pub const HEADING: &str = "## What Ylide's agents know about this project";
/// Upper bound for the notes in the Ylide section.
pub const MAX_LINES: usize = 60;
/// Characters of the file that go into an agent's prompt.
pub const PROMPT_CHARS: usize = 6_000;

const INTRO: &str = "# AGENTS.md\n\nNotes for coding agents working on this project. Write your own rules for the agents outside the Ylide section; Ylide only changes the part between its markers.\n";

/// Byte range of the Ylide section, markers included. The last start marker
/// before the first end marker wins, so a broken marker earlier in the file
/// never pulls the user's text into the section.
fn section(text: &str) -> Option<(usize, usize)> {
    let end = text.find(END)?;
    let start = text[..end].rfind(START)?;
    Some((start, end + END.len()))
}

/// The notes in the Ylide section, without markers and heading.
pub fn notes(text: &str) -> Option<String> {
    let (start, end) = section(text)?;
    let inner = &text[start + START.len()..end - END.len()];
    let body = inner.trim().strip_prefix(HEADING).unwrap_or(inner.trim());
    Some(body.trim().to_string())
}

/// `existing` with the Ylide section holding `notes`; the rest stays byte for
/// byte. Without a section, it is added at the end; without a file, a new one
/// is started.
pub fn merge(existing: Option<&str>, notes: &str) -> String {
    let notes = cap_lines(notes.trim(), MAX_LINES);
    let block = format!("{START}\n{HEADING}\n\n{notes}\n{END}");
    let newline = if existing.is_some_and(|t| t.contains("\r\n")) { "\r\n" } else { "\n" };
    let block = if newline == "\r\n" { block.replace('\n', "\r\n") } else { block };
    match existing {
        Some(text) if !text.trim().is_empty() => match section(text) {
            Some((start, end)) => format!("{}{block}{}", &text[..start], &text[end..]),
            None => {
                let sep = if text.ends_with(newline) { newline.to_string() } else { format!("{newline}{newline}") };
                format!("{text}{sep}{block}{newline}")
            }
        },
        _ => format!("{INTRO}\n{block}\n"),
    }
}

/// The notes from a model's answer: code fences, echoed markers and the
/// heading removed, runs of blank lines collapsed, at most `MAX_LINES` lines.
pub fn clean_notes(answer: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in answer.lines() {
        let t = line.trim();
        if t.starts_with("```") || t == START || t == END || t == HEADING {
            continue;
        }
        if t.is_empty() && lines.last().is_none_or(|l| l.trim().is_empty()) {
            continue;
        }
        lines.push(line.trim_end());
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    cap_lines(&lines.join("\n"), MAX_LINES)
}

fn cap_lines(text: &str, max: usize) -> String {
    text.lines().take(max).collect::<Vec<_>>().join("\n")
}

/// The file as a prompt section, cut at a line end when it is longer than
/// `max_chars`. Empty when there is no text.
pub fn prompt_section(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    let mut shown = text;
    let mut note = "";
    if text.chars().count() > max_chars {
        let cut = text.char_indices().nth(max_chars).map_or(text.len(), |(i, _)| i);
        shown = text[..cut].rfind('\n').map_or(&text[..cut], |nl| &text[..nl]);
        note = "\n[AGENTS.md goes on; the rest was left out to save context. Read the file if you need it.]";
    }
    format!(
        "Project notes from {FILE} (in the project root). Text outside the Ylide section was written by the user: follow it as rules. The Ylide section holds what agents noted in earlier runs; when it disagrees with the code, trust the code.\n<<<\n{shown}{note}\n>>>\n\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "# Shop\n\nAlways use pnpm.\nNever touch legacy/.\n";

    #[test]
    fn a_new_file_gets_an_intro_and_the_section() {
        let text = merge(None, "- Build: `pnpm build`");
        assert!(text.starts_with("# AGENTS.md\n"), "{text}");
        assert!(text.contains(&format!("{START}\n{HEADING}\n\n- Build: `pnpm build`\n{END}\n")), "{text}");
        assert_eq!(notes(&text).as_deref(), Some("- Build: `pnpm build`"));
    }

    #[test]
    fn the_users_text_stays_untouched() {
        let first = merge(Some(USER), "- Build: `pnpm build`");
        assert!(first.starts_with(USER), "the section goes at the end: {first}");
        let with_more = format!("{first}\n## My own notes\nKeep it simple.\n");
        let second = merge(Some(&with_more), "- Build: `pnpm build`\n- Tests: `pnpm test`");
        assert!(second.starts_with(USER));
        assert!(second.ends_with(&format!("{END}\n\n## My own notes\nKeep it simple.\n")), "{second}");
        assert_eq!(notes(&second).as_deref(), Some("- Build: `pnpm build`\n- Tests: `pnpm test`"));
        assert_eq!(second.matches(START).count(), 1, "the section is replaced, not added again");
    }

    #[test]
    fn windows_line_endings_are_kept() {
        let user = "# Shop\r\n\r\nAlways use pnpm.\r\n";
        let text = merge(Some(user), "- a\n- b");
        assert!(text.starts_with(user));
        assert!(!text.replace("\r\n", "").contains('\n'), "{text:?}");
        assert_eq!(notes(&text).map(|n| n.replace("\r\n", "\n")).as_deref(), Some("- a\n- b"));
    }

    #[test]
    fn a_broken_marker_never_swallows_the_users_text() {
        let broken = format!("{START}\nhalf a section\n\n# Rules\nUse tabs.\n");
        let text = merge(Some(&broken), "- notes");
        assert!(text.starts_with(&broken), "{text}");
        let again = merge(Some(&text), "- newer notes");
        assert!(again.starts_with(&broken), "{again}");
        assert_eq!(notes(&again).as_deref(), Some("- newer notes"));
    }

    #[test]
    fn the_notes_are_capped() {
        let long: String = (1..=100).map(|i| format!("- note {i}\n")).collect();
        let text = merge(Some(USER), &long);
        let n = notes(&text).unwrap();
        assert_eq!(n.lines().count(), MAX_LINES);
        assert!(n.ends_with("- note 60"));
        assert_eq!(clean_notes(&long).lines().count(), MAX_LINES);
    }

    #[test]
    fn answers_are_cleaned() {
        let answer = format!("```markdown\n{START}\n{HEADING}\n\n- Build: `cargo build`\n\n\n- Tests: `cargo test`\n{END}\n```\n\n");
        assert_eq!(clean_notes(&answer), "- Build: `cargo build`\n\n- Tests: `cargo test`");
        assert_eq!(clean_notes("  \n\n"), "");
    }

    #[test]
    fn the_prompt_section_is_bounded() {
        assert_eq!(prompt_section("  \n", 100), "");
        let short = prompt_section(USER, 1_000);
        assert!(short.contains("follow it as rules"));
        assert!(short.contains("<<<\n# Shop\n\nAlways use pnpm.\nNever touch legacy/.\n>>>"), "{short}");
        let long: String = (1..=500).map(|i| format!("line {i}\n")).collect();
        let cut = prompt_section(&long, 100);
        assert!(cut.contains("line 1\n") && !cut.contains("line 99\n"), "{cut}");
        // Lines 1-13 fill 94 characters; line 14 would cross 100, so it is left out whole.
        assert!(cut.contains("line 13\n[AGENTS.md goes on; the rest was left out"), "{cut}");
        assert!(!cut.contains("line 14"), "{cut}");
    }
}
