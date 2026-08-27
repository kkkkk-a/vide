/* tslint:disable */
/* eslint-disable */

export function apply_chroma_key(pixels: Uint8Array, target_r: number, target_g: number, target_b: number, tolerance: number, smoothness: number): void;

export function apply_cinematic_lut(pixels: Uint8Array, preset: string, intensity: number): void;

export function apply_color_filters(pixels: Uint8Array, brightness: number, contrast: number, grayscale: number, saturate: number, invert: number): void;

export function apply_custom_3d_lut(pixels: Uint8Array, lut_table: Float32Array, lut_size: number, intensity: number): void;

export function detect_audio_beats(samples: Float32Array, sample_rate: number, sensitivity: number, min_interval_sec: number): Float32Array;

export function extract_waveform_peaks(raw_samples: Float32Array, samples_count: number): Float32Array;

export function render_complete_music(genre: string, bpm: number, bars: number, sample_rate: number): Float32Array;

export function render_song_maker_music(melody_flat: Uint8Array, drum_flat: Uint8Array, scale_freqs: Float32Array, steps: number, bpm: number, instrument: string, drum_kit: string, sample_rate: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly apply_chroma_key: (a: number, b: number, c: any, d: number, e: number, f: number, g: number, h: number) => void;
    readonly apply_cinematic_lut: (a: number, b: number, c: any, d: number, e: number, f: number) => void;
    readonly apply_color_filters: (a: number, b: number, c: any, d: number, e: number, f: number, g: number, h: number) => void;
    readonly apply_custom_3d_lut: (a: number, b: number, c: any, d: number, e: number, f: number, g: number) => void;
    readonly detect_audio_beats: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly extract_waveform_peaks: (a: number, b: number, c: number) => [number, number];
    readonly render_complete_music: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly render_song_maker_music: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
