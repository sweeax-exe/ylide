//! Fallback for models that print tool calls as text instead of using native
//! function calling (common with small local models or mismatched templates).
//!
//! Recognised forms:
//! * qwen3_coder XML: `<function=NAME><parameter=KEY>VALUE</parameter></function>`,
//!   optionally inside `<tool_call>`. Qwen3.6 leaks these into `content` for a
//!   share of calls on current llama.cpp builds (issue #30118), so this repair
//!   is required, not optional.
//! * `<tool_call>{"name": "...", "arguments": {...}}</tool_call>` (Hermes/Qwen)
//! * a fenced ```json block with `name` + `arguments` (or `tool` + `args`)
//! * a bare JSON object with those keys making up the whole message

use inference::{FunctionCall, ToolCall};
use serde_json::{Map, Value};

/// Extracts tool calls for the given known tool names. Returns the calls and
/// the remaining text with the call markup removed.
pub fn parse_text_tool_calls(content: &str, known: &[&str]) -> (Vec<ToolCall>, String) {
    let (calls, rest) = parse_xml_function_calls(content);
    if !calls.is_empty() {
        return (calls, rest);
    }
    let mut calls = Vec::new();
    let mut rest = content.to_string();

    // 1. <tool_call> ... </tool_call>
    while let Some(start) = rest.find("<tool_call>") {
        let after = start + "<tool_call>".len();
        let end = rest[after..].find("</tool_call>").map(|e| after + e);
        let body = &rest[after..end.unwrap_or(rest.len())];
        if let Some(call) = to_call(body.trim(), known, calls.len()) {
            calls.push(call);
        }
        let cut_end = end.map(|e| e + "</tool_call>".len()).unwrap_or(rest.len());
        rest.replace_range(start..cut_end, "");
    }
    if !calls.is_empty() {
        return (calls, rest.trim().to_string());
    }

    // 2. fenced json blocks
    let mut search_from = 0;
    while let Some(open) = rest[search_from..].find("```").map(|i| search_from + i) {
        let header_end = rest[open..].find('\n').map(|i| open + i + 1).unwrap_or(rest.len());
        let Some(close) = rest[header_end..].find("```").map(|i| header_end + i) else { break };
        let body = rest[header_end..close].trim().to_string();
        if let Some(call) = to_call(&body, known, calls.len()) {
            calls.push(call);
            rest.replace_range(open..close + 3, "");
            search_from = open;
        } else {
            search_from = close + 3;
        }
    }
    if !calls.is_empty() {
        return (calls, rest.trim().to_string());
    }

    // 3. the whole message is a JSON object
    if let Some(call) = to_call(content.trim(), known, 0) {
        return (vec![call], String::new());
    }
    (vec![], content.to_string())
}

/// `<function=NAME>` blocks with `<parameter=KEY>` children (qwen3_coder format).
/// Values are raw text; types are fixed later by `tools::normalize_arguments`.
fn parse_xml_function_calls(content: &str) -> (Vec<ToolCall>, String) {
    let mut calls = Vec::new();
    let mut rest = content.to_string();
    while let Some(start) = rest.find("<function=") {
        let name_start = start + "<function=".len();
        let Some(name_end) = rest[name_start..].find('>').map(|i| name_start + i) else { break };
        let name = rest[name_start..name_end].trim().trim_matches('"').to_string();
        let body_start = name_end + 1;
        let body_end = rest[body_start..].find("</function>").map(|i| body_start + i).unwrap_or(rest.len());
        let body = rest[body_start..body_end].to_string();
        let mut cut_end = (body_end + "</function>".len()).min(rest.len());
        let mut cut_start = start;
        // Remove a surrounding <tool_call> ... </tool_call> as well.
        if let Some(open) = rest[..start].rfind("<tool_call>")
            && rest[open + "<tool_call>".len()..start].trim().is_empty()
        {
            cut_start = open;
        }
        if let Some(close) = rest[cut_end..].find("</tool_call>")
            && rest[cut_end..cut_end + close].trim().is_empty()
        {
            cut_end += close + "</tool_call>".len();
        }
        // The XML form is unambiguous, so unknown names are kept: the runner then
        // tells the model that the tool does not exist instead of ignoring it.
        if !name.is_empty() && !name.contains(char::is_whitespace) {
            let mut args = Map::new();
            let mut cursor = 0;
            while let Some(p) = body[cursor..].find("<parameter=") {
                let key_start = cursor + p + "<parameter=".len();
                let Some(key_end) = body[key_start..].find('>').map(|i| key_start + i) else { break };
                let key = body[key_start..key_end].trim().trim_matches('"').to_string();
                let value_start = key_end + 1;
                let value_end = body[value_start..].find("</parameter>").map(|i| value_start + i).unwrap_or(body.len());
                let raw = &body[value_start..value_end];
                // The format puts values on their own lines: strip exactly one leading/trailing newline.
                let raw = raw.strip_prefix("\r\n").or_else(|| raw.strip_prefix('\n')).unwrap_or(raw);
                let raw = raw.strip_suffix("\r\n").or_else(|| raw.strip_suffix('\n')).unwrap_or(raw);
                args.insert(key, Value::String(raw.to_string()));
                cursor = (value_end + "</parameter>".len()).min(body.len());
            }
            calls.push(ToolCall {
                id: format!("xml_call_{}", calls.len()),
                kind: "function".into(),
                function: FunctionCall {
                    name,
                    arguments: Value::Object(args).to_string(),
                },
            });
        }
        rest.replace_range(cut_start..cut_end, "");
    }
    (calls, rest.trim().to_string())
}

fn to_call(text: &str, known: &[&str], index: usize) -> Option<ToolCall> {
    let v: Value = serde_json::from_str(text).ok()?;
    let obj = v.as_object()?;
    let name = obj
        .get("name")
        .or_else(|| obj.get("tool"))
        .or_else(|| obj.get("function"))
        .and_then(Value::as_str)?;
    if !known.contains(&name) {
        return None;
    }
    let args = obj
        .get("arguments")
        .or_else(|| obj.get("args"))
        .or_else(|| obj.get("parameters"))
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    // Some models double-encode arguments as a JSON string.
    let arguments = match args {
        Value::String(s) => s,
        other => other.to_string(),
    };
    Some(ToolCall {
        id: format!("text_call_{index}"),
        kind: "function".into(),
        function: FunctionCall {
            name: name.to_string(),
            arguments,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &[&str] = &["read_file", "finish"];

    #[test]
    fn hermes_style_tags() {
        let text = "Let me look.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.rs\"}}\n</tool_call>";
        let (calls, rest) = parse_text_tool_calls(text, KNOWN);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "read_file");
        assert_eq!(calls[0].function.arguments, r#"{"path":"a.rs"}"#);
        assert_eq!(rest, "Let me look.");
    }

    #[test]
    fn fenced_json_and_string_arguments() {
        let text = "```json\n{\"tool\": \"finish\", \"args\": \"{\\\"summary\\\": \\\"done\\\"}\"}\n```";
        let (calls, _) = parse_text_tool_calls(text, KNOWN);
        assert_eq!(calls[0].function.name, "finish");
        assert_eq!(calls[0].function.arguments, r#"{"summary": "done"}"#);
    }

    #[test]
    fn bare_object_and_unknown_tools() {
        let (calls, _) = parse_text_tool_calls(r#"{"name": "finish", "arguments": {"summary": "x"}}"#, KNOWN);
        assert_eq!(calls.len(), 1);
        let (calls, rest) = parse_text_tool_calls(r#"{"name": "rm_rf", "arguments": {}}"#, KNOWN);
        assert!(calls.is_empty());
        assert!(rest.contains("rm_rf"));
    }

    #[test]
    fn qwen3_coder_xml_calls_are_repaired() {
        let text = "I'll read it.\n<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/main.rs\n</parameter>\n</function>\n</tool_call>";
        let (calls, rest) = parse_text_tool_calls(text, KNOWN);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "read_file");
        assert_eq!(calls[0].function.arguments, r#"{"path":"src/main.rs"}"#);
        assert_eq!(rest, "I'll read it.");
    }

    #[test]
    fn xml_values_keep_inner_newlines_and_multiple_calls_work() {
        let known = &["edit_file", "finish"];
        let text = "<function=edit_file>\n<parameter=path>\na.rs\n</parameter>\n<parameter=new_text>\nline 1\n\nline 3\n</parameter>\n</function>\n<function=finish>\n<parameter=summary>\ndone\n</parameter>\n</function>";
        let (calls, rest) = parse_text_tool_calls(text, known);
        assert_eq!(calls.len(), 2);
        let args: Value = serde_json::from_str(&calls[0].function.arguments).unwrap();
        assert_eq!(args["new_text"], "line 1\n\nline 3");
        assert_eq!(calls[1].function.name, "finish");
        assert!(rest.is_empty());
    }

    #[test]
    fn xml_calls_to_unknown_tools_are_kept_for_an_error_reply() {
        let (calls, rest) = parse_text_tool_calls("<function=format_disk>\n<parameter=d>\nC\n</parameter>\n</function>", KNOWN);
        assert_eq!(calls[0].function.name, "format_disk");
        assert!(rest.is_empty());
    }

    #[test]
    fn ordinary_code_blocks_are_left_alone() {
        let text = "Here is code:\n```rust\nfn main() {}\n```";
        let (calls, rest) = parse_text_tool_calls(text, KNOWN);
        assert!(calls.is_empty());
        assert_eq!(rest, text);
    }
}
