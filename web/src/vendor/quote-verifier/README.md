# Quote verifier (generated)

The WebAssembly build the board uses to check OutLayer's Intel TDX quotes in the visitor's browser. It is built from [`web/quote-verifier`](../../../quote-verifier), a small wrapper around [`dcap-qvl`](https://crates.io/crates/dcap-qvl) 0.5.2, the library OutLayer verifies its quotes with. Do not edit these files: change the crate and run

```sh
web/scripts/build-quote-verifier.sh
```

which needs Rust with the `wasm32-unknown-unknown` target and `wasm-pack`. The build is committed so that building the board needs no Rust. [`src/lib/attestation.ts`](../../lib/attestation.ts) loads it the first time someone presses "Check the enclave proof" on a result page. The crates it links and their licences are in [THIRD-PARTY.md](THIRD-PARTY.md).
