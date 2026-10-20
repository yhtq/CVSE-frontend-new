{
  description = "CVSE browser RPC (Rust/WASM client and Rust WebSocket relay)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, rust-overlay, ... }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
      };
      rust = pkgs.rust-bin.stable.latest.default.override {
        targets = [ "wasm32-unknown-unknown" ];
      };
      source = pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          !(builtins.elem (baseNameOf path) [
            ".git" "node_modules" "target" "pkg" "wasm" "result" ".direnv"
          ]);
      };
      wasmPlatform = pkgs.makeRustPlatform { rustc = rust; cargo = rust; };
      wasm = wasmPlatform.buildRustPackage {
        pname = "cvse-wasm-client";
        version = "0.1.0";
        src = source;
        cargoRoot = "wasm-client";
        buildAndTestSubdir = "wasm-client";
        cargoLock.lockFile = ./wasm-client/Cargo.lock;
        nativeBuildInputs = [ pkgs.capnproto pkgs.wasm-bindgen-cli ];

        doCheck = false; # Browser-specific code cannot run on the build host.
        buildPhase = ''
          runHook preBuild
          cargo build --offline --locked --release --target wasm32-unknown-unknown --manifest-path wasm-client/Cargo.toml
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/static/wasm
          wasm-bindgen --target web --out-dir $out/static/wasm wasm-client/target/wasm32-unknown-unknown/release/cvse_wasm_client.wasm
          runHook postInstall
        '';
      };
      relay = pkgs.pkgsStatic.rustPlatform.buildRustPackage {
        pname = "cvse-relay";
        version = "0.1.0";
        src = source;
        cargoRoot = "relay";
        buildAndTestSubdir = "relay";
        cargoLock.lockFile = ./relay/Cargo.lock;
        doCheck = false; # Host-side tests run in the development shell.
      };
      deployment = pkgs.runCommand "cvse-deployment" { } ''
        mkdir -p $out/bin $out/share/cvse-frontend/static
        cp ${relay}/bin/cvse-relay $out/bin/cvse-relay
        cp ${source}/index.html $out/share/cvse-frontend/index.html
        cp -r ${source}/static/. $out/share/cvse-frontend/static/
        cp -r ${wasm}/static/wasm $out/share/cvse-frontend/static/wasm
      '';
    in {
      packages = pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
        default = deployment;
        inherit relay wasm;
      };
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          rust
          wasm-bindgen-cli
          capnproto
          nodejs
        ];
        # The native relay is linked with Nix's C toolchain; WASM has no C linker.
      };
    });
}
