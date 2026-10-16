//! Prints the hardware profile as JSON: `cargo run -p hardware --example probe`.

fn main() {
    let dir = std::env::current_dir().ok();
    let profile = hardware::probe(dir.as_deref());
    println!("{}", serde_json::to_string_pretty(&profile).expect("serializable"));
}
