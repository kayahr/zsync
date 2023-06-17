/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { FileHandle } from "node:fs/promises";

import { rsum } from "./rsum";

export const BITHASHBITS = 3;

export interface hash_entry {
    next: hash_entry | null;    /* next entry with the same rsum */
    r: rsum;
    checksum: Uint8Array | null;
}

export interface rcksum_state {
    r: [ rsum, rsum ];           /* Current rsums */

    blocks: number;          /* Number of blocks in the target file */
    blocksize: number;           /* And how many bytes per block */
    blockshift: number;             /* log2(blocksize) */
    rsum_a_mask: number; /* The mask to apply to rsum values before looking up */
    rsum_bits: number;   /* # of bits of rsum data in the .zsync for each block */
    hash_func_shiftL: number; /* Config for the hash function */
    checksum_bytes: number; /* How many bytes of the MD4 checksum are available */
    seq_matches: number;
    context: number;       /* precalculated blocksize * seq_matches */

    /* These are used by the library. Note, not thread safe. */
    skip: number;                   /* skip forward on next submit_source_data */
    rover: hash_entry | null;

    /* Internal; hint to rcksum_submit_source_data that it should try matching
     * the following block of input data against the block ->next_match.
     * next_known is a cached lookup of the id of the next block after that
     * that we already have data for. */
    next_match: hash_entry | null;
    next_known: number;

    /* Hash table for rsync algorithm */
    hashmask: number;
    blockhashes: hash_entry[];
    rsum_hash: Array<hash_entry | null> | null;

    /* And a 1-bit per rsum value table to allow fast negative lookups for hash
     * values that don't occur in the target file. */
    bithash: Uint8Array | null;
    bithashmask: number;

    /* Current state and stats for data collected by algorithm */
    numranges: number;
    ranges: number[];
    gotblocks: number;
    stats: {
        hashhit: number;
        weakhit: number;
        stronghit: number;
        checksummed: number;
    };

    /* Temp file for output */
    filename: string | null;
    fd: FileHandle | null;
}

/* Hash the checksum values for the given hash entry and return the hash value */
export function calc_rhash(z: rcksum_state, e: hash_entry[], ei: number): number {
    let h: number = e[ei].r.b;

    h ^= ((z.seq_matches > 1) ? e[ei + 1].r.b
        : e[0].r.a & z.rsum_a_mask) << BITHASHBITS;

    return h;
}

/* From a hash entry, return the corresponding blockid */
export function get_HE_blockid(z: rcksum_state, e: hash_entry): number {
    // return e - z->blockhashes;
    const index = z.blockhashes.indexOf(e); // TODO multiply with pointer size?
    if (index < 0) {
        throw new Error("get_HE_blockid failed");
    }
    return index;
}
