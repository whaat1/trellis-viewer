fn main() {
    let target =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/contracts.ts");
    let expected = trellis_viewer_lib::contracts::typescript();
    if std::env::args().any(|arg| arg == "--check") {
        assert_eq!(
            std::fs::read_to_string(target).unwrap(),
            expected,
            "generated contracts are stale"
        );
    } else {
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, expected).unwrap();
    }
}
