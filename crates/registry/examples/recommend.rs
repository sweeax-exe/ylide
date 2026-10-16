//! Probes this machine and prints the recommendation from the bundled registry:
//! `cargo run -p registry --example recommend`.

use registry::estimate::Placement;

fn gb(bytes: u64) -> f64 {
    bytes as f64 / (1u64 << 30) as f64
}

fn line(label: &str, c: &registry::Candidate) {
    let p = &c.plan;
    let placement = match p.placement {
        Placement::Gpu => "GPU".to_string(),
        Placement::MoeOffload { cpu_expert_layers } => format!("GPU + {cpu_expert_layers} expert layers in RAM"),
        Placement::PartialOffload { gpu_layers } => format!("{gpu_layers} layers on GPU"),
        Placement::Unified => "unified memory".into(),
        Placement::Cpu => "CPU".into(),
    };
    println!(
        "{label:<12} {:<26} {:<11} ctx {:>6}  {:<32} VRAM {:>5.1} GiB  RAM {:>5.1} GiB  ~{:>4.0} tok/s  score {:.1}",
        c.model_id,
        c.quant,
        p.context,
        placement,
        gb(p.vram_bytes),
        gb(p.ram_bytes),
        p.est_tokens_per_sec,
        c.score
    );
}

fn main() {
    let registry = registry::bundled();
    let dir = std::env::current_dir().ok();
    let hw = hardware::probe(dir.as_deref());
    let r = registry::recommend(&registry, &hw);
    println!(
        "budget: VRAM {:.1} GiB @ {} GB/s, RAM {:.1} GiB @ {} GB/s, backend {:?}, gpu {:?}\n",
        gb(r.budget.vram_bytes),
        r.budget.gpu_bandwidth_gbps,
        gb(r.budget.ram_bytes),
        r.budget.ram_bandwidth_gbps,
        r.budget.backend,
        r.budget.gpu_name
    );
    match &r.primary {
        Some(p) => line("primary", p),
        None => println!("no primary"),
    }
    for a in &r.alternatives {
        line(&format!("{:?}", a.kind).to_lowercase(), &a.candidate);
    }
    if let Some(a) = &r.autocomplete {
        line("autocomplete", a);
    }
    if let Some(e) = &r.embedding {
        line("embedding", e);
    }
    if let Some(p) = &r.primary {
        println!("\nreasons:");
        for reason in &p.reasons {
            println!("  {:?} {:?}", reason.code, reason.params);
        }
    }
    for n in &r.notices {
        println!("notice: {:?} {:?}", n.code, n.params);
    }
}
