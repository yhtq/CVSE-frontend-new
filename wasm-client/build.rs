fn main() {
    let schema = "../CVSE-API/CVSE.capnp";
    println!("cargo:rerun-if-changed={schema}");
    let mut command = capnpc::CompilerCommand::new();
    if let Ok(executable) = std::env::var("CAPNP") {
        command.capnp_executable(executable);
    }
    command
        .src_prefix("../CVSE-API")
        .file(schema)
        .run()
        .expect("capnp compiler required to build the CVSE RPC client");
}
