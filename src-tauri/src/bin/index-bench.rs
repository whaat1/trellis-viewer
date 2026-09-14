fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .expect("usage: index-bench ABSOLUTE_PROJECT_PATH [ITERATIONS]");
    let iterations: usize = args
        .next()
        .map(|value| value.parse().expect("invalid iterations"))
        .unwrap_or(10);
    assert!(
        (1..=100).contains(&iterations),
        "iterations must be between 1 and 100"
    );
    println!(
        "{}",
        trellis_viewer_lib::benchmark_index(&path, iterations).expect("index benchmark failed")
    );
}
