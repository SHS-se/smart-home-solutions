use std::io::{self, Read, Write};
fn main() {
    let mut input = Vec::new();
    io::stdin()
        .read_to_end(&mut input)
        .expect("read ready problem");
    io::stdout()
        .write_all(&shs_planner_core::solve_json(&input))
        .expect("write selected result");
}
