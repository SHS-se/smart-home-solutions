use std::io::{self, Read, Write};
fn main() {
    let mut input = Vec::new();
    io::stdin()
        .read_to_end(&mut input)
        .expect("read ready problem");
    let output = if std::env::args().nth(1).as_deref() == Some("--room") {
        shs_planner_core::room_heating::plan_json(&input)
    } else {
        shs_planner_core::solve_json(&input)
    };
    io::stdout()
        .write_all(&output)
        .expect("write selected result");
}
