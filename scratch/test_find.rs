
use ignore::WalkBuilder;
use std::path::Path;

fn main() {
    let root = "/Users/stevenmorales/Development/StellarumPrism";
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .build();

    let target = ".prism/competition/vc-pitchdeck-2.md";
    let mut found = false;

    for entry in walker {
        let entry = entry.unwrap();
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
        if rel.to_string_lossy() == target {
            println!("FOUND: {:?}", rel);
            found = true;
            break;
        }
    }

    if !found {
        println!("NOT FOUND");
    }
}
