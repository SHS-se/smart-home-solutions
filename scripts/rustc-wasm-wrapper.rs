// Cargo salts symbols with host-dependent dependency metadata. Replace that
// salt rather than append to it, while preserving distinct package identities.
use std::{env, ffi::OsString, process::Command};

fn main() {
    let mut input = env::args_os().skip(1).peekable();
    let compiler = input.next().expect("Cargo must supply rustc");
    let mut args: Vec<OsString> = Vec::new();
    let mut crate_name = String::new();
    let mut target = String::from("host");
    let mut metadata = false;
    while let Some(arg) = input.next() {
        match arg.to_str() {
            Some("-C")
                if input
                    .peek()
                    .and_then(|v| v.to_str())
                    .is_some_and(|v| v.starts_with("metadata=")) =>
            {
                input.next();
                metadata = true;
            }
            Some(value) if value.starts_with("-Cmetadata=") => metadata = true,
            Some("--crate-name" | "--target") => {
                let value = input.next().expect("Missing rustc option value");
                if arg == "--crate-name" {
                    crate_name = value.to_str().expect("Invalid crate name").into();
                } else {
                    target = value.to_str().expect("Invalid target").into();
                }
                args.extend([arg, value]);
            }
            _ => args.push(arg),
        }
    }
    if metadata {
        let package = env::var("CARGO_PKG_NAME").expect("Cargo must identify the package");
        let version = env::var("CARGO_PKG_VERSION").expect("Cargo must identify its version");
        args.push("-C".into());
        args.push(
            format!("metadata=shs-planner-abi2:{package}@{version}:{crate_name}:{target}").into(),
        );
    }
    let status = Command::new(compiler)
        .args(args)
        .status()
        .expect("Could not execute rustc");
    std::process::exit(
        status
            .code()
            .expect("rustc terminated without an exit code"),
    );
}
