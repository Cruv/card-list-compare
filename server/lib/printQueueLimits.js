// Source art is staged sequentially on disk. High-resolution saved MPC images
// need more room than the in-memory Scryfall ZIP download path.
export const MAX_PRINT_SOURCE_BYTES = 1536 * 1024 * 1024;
