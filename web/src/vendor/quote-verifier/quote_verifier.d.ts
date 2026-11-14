/* tslint:disable */
/* eslint-disable */

export function js_verify(raw_quote: any, quote_collateral: any, now: bigint): any;

export function js_verify_with_root_ca(raw_quote: any, quote_collateral: any, root_ca_der: any, now: bigint): any;

/**
 * The platform a quote claims, so the caller can fetch the matching collateral. Unverified by
 * definition: it is only a lookup key, and the verification that follows is what counts.
 */
export function quote_platform(quote: Uint8Array): any;

/**
 * Verify a quote against Intel's collateral as of `at_secs`, the moment the run was attested:
 * collateral is valid only inside its window, so a past run is judged by what was current then.
 */
export function verify_quote(quote: Uint8Array, collateral_json: string, at_secs: number): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly quote_platform: (a: number, b: number) => any;
    readonly verify_quote: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly js_verify: (a: any, b: any, c: bigint) => [number, number, number];
    readonly js_verify_with_root_ca: (a: any, b: any, c: any, d: bigint) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
