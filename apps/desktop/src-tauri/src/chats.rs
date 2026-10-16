//! Saved chats, per project, on this computer only:
//! `<local data>/chats/<project key>/<chat id>.json` plus `index.json` with a
//! summary of each. The conversation is stored as the UI keeps it (opaque
//! JSON, with its format number), so a continued chat sends the earlier turns
//! to the model byte-identical, attached file contents included.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ts_rs::TS;

/// A saved chat larger than this is refused (a chat with many attached files
/// stays far below it).
const MAX_CHAT_BYTES: usize = 32 << 20;
const INDEX: &str = "index.json";
/// Folder for chats held while no project is open.
const NO_PROJECT: &str = "no-project";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
    #[ts(type = "number")]
    pub updated_at_unix_ms: u64,
    /// Number of messages, questions and answers together.
    pub turns: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoredChat {
    pub summary: ChatSummary,
    /// Version of the UI's conversation format, so later versions can read old chats.
    pub format: u32,
    #[ts(type = "unknown")]
    pub turns: serde_json::Value,
}

pub struct ChatStore {
    root: PathBuf,
    /// Saves and deletes of one store run one at a time, so the index never loses an entry.
    lock: Mutex<()>,
}

/// Chat ids come from the UI (UUIDs); anything else could escape the folder.
/// "index" would be the index file itself (in any letter case, on Windows).
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !id.eq_ignore_ascii_case("index")
}

fn bad_id(id: &str) -> AppError {
    AppError::new("chat_id", format!("invalid chat id {id:?}"))
}

/// Writes via a flushed temporary file and a rename, so even after a crash or
/// power loss the file holds the old or the new content. A temporary file
/// left by a failed write is removed (it holds the whole chat).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let result = fs::File::create(&tmp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

impl ChatStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            lock: Mutex::new(()),
        }
    }

    /// Folder of a project's chats (a hash of its path, like the checkpoints).
    fn dir(&self, project: Option<&Path>) -> PathBuf {
        match project {
            Some(root) => {
                use sha2::{Digest, Sha256};
                let key = root.display().to_string().to_lowercase();
                self.root.join(&hex::encode(Sha256::digest(key.as_bytes()))[..16])
            }
            None => self.root.join(NO_PROJECT),
        }
    }

    /// Summaries, newest first.
    pub fn list(&self, project: Option<&Path>) -> Vec<ChatSummary> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read_index(&self.dir(project))
    }

    /// The index, checked against the chat files: an entry whose file is gone
    /// is dropped, and a file the index misses (Ylide stopped between writing
    /// the chat and the index, or the index is broken) is read and added.
    fn read_index(&self, dir: &Path) -> Vec<ChatSummary> {
        let ids: HashSet<String> = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| {
                let path = e.path();
                let id = path.file_stem()?.to_str()?;
                (path.extension().is_some_and(|x| x == "json") && valid_id(id)).then(|| id.to_string())
            })
            .collect();
        let indexed: Vec<ChatSummary> = fs::read_to_string(dir.join(INDEX))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut list: Vec<ChatSummary> = indexed.into_iter().filter(|s| ids.contains(&s.id)).collect();
        let listed: HashSet<String> = list.iter().map(|s| s.id.clone()).collect();
        for id in ids.difference(&listed) {
            let chat = fs::read_to_string(dir.join(format!("{id}.json")))
                .ok()
                .and_then(|s| serde_json::from_str::<StoredChat>(&s).ok());
            if let Some(chat) = chat.filter(|c| &c.summary.id == id) {
                list.push(chat.summary);
            }
        }
        list.sort_by_key(|s| std::cmp::Reverse(s.updated_at_unix_ms));
        list
    }

    fn write_index(&self, dir: &Path, list: &[ChatSummary]) -> AppResult<()> {
        write_atomic(&dir.join(INDEX), &serde_json::to_vec_pretty(list)?)?;
        Ok(())
    }

    pub fn load(&self, project: Option<&Path>, id: &str) -> AppResult<StoredChat> {
        if !valid_id(id) {
            return Err(bad_id(id));
        }
        let path = self.dir(project).join(format!("{id}.json"));
        let text = fs::read_to_string(&path).map_err(|_| AppError::new("chat_missing", format!("no saved chat {id}")))?;
        let chat: StoredChat = serde_json::from_str(&text)?;
        if chat.summary.id != id {
            return Err(AppError::new("chat_missing", format!("the file of chat {id} holds another chat")));
        }
        Ok(chat)
    }

    /// Creates or replaces a chat and returns its summary.
    pub fn save(&self, project: Option<&Path>, chat: &StoredChat) -> AppResult<ChatSummary> {
        let id = &chat.summary.id;
        if !valid_id(id) {
            return Err(bad_id(id));
        }
        let bytes = serde_json::to_vec(chat)?;
        if bytes.len() > MAX_CHAT_BYTES {
            return Err(AppError::new("chat_too_large", format!("the chat is larger than {} MB", MAX_CHAT_BYTES >> 20)));
        }
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let dir = self.dir(project);
        fs::create_dir_all(&dir)?;
        write_atomic(&dir.join(format!("{id}.json")), &bytes)?;
        let mut list = self.read_index(&dir);
        list.retain(|s| &s.id != id);
        list.insert(0, chat.summary.clone());
        list.sort_by_key(|s| std::cmp::Reverse(s.updated_at_unix_ms));
        self.write_index(&dir, &list)?;
        Ok(chat.summary.clone())
    }

    pub fn delete(&self, project: Option<&Path>, id: &str) -> AppResult<()> {
        if !valid_id(id) {
            return Err(bad_id(id));
        }
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let dir = self.dir(project);
        // A file another program holds open stays on disk: say so instead of
        // reporting the chat as deleted. The temporary file of a save that
        // failed halfway holds the chat too.
        for name in [format!("{id}.json"), format!("{id}.tmp")] {
            match fs::remove_file(dir.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        let mut list = self.read_index(&dir);
        list.retain(|s| s.id != id);
        if dir.exists() {
            self.write_index(&dir, &list)?;
        }
        Ok(())
    }

    /// Deletes the saved chats of every project.
    pub fn delete_all(&self) -> AppResult<()> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        match fs::remove_dir_all(&self.root) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, title: &str, updated: u64) -> StoredChat {
        StoredChat {
            summary: ChatSummary {
                id: id.into(),
                title: title.into(),
                created_at_unix_ms: 1,
                updated_at_unix_ms: updated,
                turns: 2,
            },
            format: 1,
            turns: serde_json::json!([{ "role": "user", "content": title }, { "role": "assistant", "content": "ok" }]),
        }
    }

    #[test]
    fn saves_lists_newest_first_and_loads() {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path());
        let project = Path::new("D:/work/shop");
        store.save(Some(project), &chat("a-1", "first", 10)).unwrap();
        store.save(Some(project), &chat("b-2", "second", 20)).unwrap();
        let list = store.list(Some(project));
        assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b-2", "a-1"]);
        assert_eq!(store.load(Some(project), "a-1").unwrap(), chat("a-1", "first", 10));
        // Saving again replaces the chat and moves it to the top.
        store.save(Some(project), &chat("a-1", "first, longer", 30)).unwrap();
        let list = store.list(Some(project));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "first, longer");
    }

    #[test]
    fn projects_keep_their_own_chats() {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path());
        store.save(Some(Path::new("D:/a")), &chat("x", "in a", 1)).unwrap();
        store.save(None, &chat("y", "no project", 1)).unwrap();
        assert_eq!(store.list(Some(Path::new("D:/a"))).len(), 1);
        assert_eq!(store.list(Some(Path::new("D:/b"))).len(), 0);
        assert_eq!(store.list(None)[0].id, "y");
        // The same folder in another letter case is the same project on Windows.
        assert_eq!(store.list(Some(Path::new("d:/A"))).len(), 1);
    }

    #[test]
    fn deletes_one_or_all() {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path().join("chats"));
        let p = Some(Path::new("D:/a"));
        store.save(p, &chat("x", "one", 1)).unwrap();
        store.save(p, &chat("y", "two", 2)).unwrap();
        // As if a save of "x" had failed after writing its temporary file.
        let folder = store.dir(p);
        fs::write(folder.join("x.tmp"), "the whole chat").unwrap();
        store.delete(p, "x").unwrap();
        assert!(!folder.join("x.tmp").exists());
        assert_eq!(store.list(p).iter().map(|s| s.id.clone()).collect::<Vec<_>>(), ["y"]);
        assert_eq!(store.load(p, "x").unwrap_err().code, "chat_missing");
        store.delete_all().unwrap();
        assert!(store.list(p).is_empty());
        store.delete_all().unwrap();
    }

    #[test]
    fn refuses_ids_that_could_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path());
        for id in ["../escape", "a/b", "a\\b", "", "with space", &"x".repeat(65), "index", "INDEX"] {
            assert_eq!(store.save(None, &chat(id, "t", 1)).unwrap_err().code, "chat_id", "{id}");
            assert_eq!(store.load(None, id).unwrap_err().code, "chat_id", "{id}");
            assert_eq!(store.delete(None, id).unwrap_err().code, "chat_id", "{id}");
        }
    }

    #[test]
    fn rebuilds_a_broken_index_from_the_chat_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path());
        store.save(None, &chat("a", "one", 1)).unwrap();
        store.save(None, &chat("b", "two", 2)).unwrap();
        fs::write(dir.path().join(NO_PROJECT).join(INDEX), "{ broken").unwrap();
        assert_eq!(store.list(None).iter().map(|s| s.id.clone()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn keeps_the_index_in_step_with_the_chat_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path());
        store.save(None, &chat("a", "one", 1)).unwrap();
        store.save(None, &chat("b", "two", 2)).unwrap();
        let folder = dir.path().join(NO_PROJECT);
        // As if Ylide stopped after writing chat "c" but before the index, and
        // chat "a"'s file was removed by hand.
        fs::write(folder.join("c.json"), serde_json::to_vec(&chat("c", "three", 3)).unwrap()).unwrap();
        fs::remove_file(folder.join("a.json")).unwrap();
        assert_eq!(store.list(None).iter().map(|s| s.id.clone()).collect::<Vec<_>>(), ["c", "b"]);
        // A file whose content names another chat is not listed under its name.
        fs::write(folder.join("d.json"), serde_json::to_vec(&chat("e", "other", 4)).unwrap()).unwrap();
        assert_eq!(store.list(None).len(), 2);
    }

    /// Another program holding the file open must not make the chat look deleted.
    #[cfg(windows)]
    #[test]
    fn reports_a_chat_that_could_not_be_deleted() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path());
        store.save(None, &chat("x", "one", 1)).unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(dir.path().join(NO_PROJECT).join("x.json")).unwrap();
        assert!(store.delete(None, "x").is_err());
        assert_eq!(store.list(None).len(), 1);
        drop(held);
        store.delete(None, "x").unwrap();
        assert!(store.list(None).is_empty());
    }

    #[test]
    fn refuses_huge_chats() {
        let dir = tempfile::tempdir().unwrap();
        let store = ChatStore::new(dir.path());
        let mut big = chat("big", "big", 1);
        big.turns = serde_json::Value::String("x".repeat(MAX_CHAT_BYTES + 1));
        assert_eq!(store.save(None, &big).unwrap_err().code, "chat_too_large");
    }
}
