/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import { BITHASHBITS, calc_rhash, hash_entry, rcksum_state } from "./internal";
import { rsum } from "./rsum";

/* rcksum_add_target_block(self, blockid, rsum, checksum)
 * Sets the stored hash values for the given blockid to the given values.
 */
export function rcksum_add_target_block(z: rcksum_state, b: number, r: rsum, checksum: Uint8Array): void {
    if (b < z.blocks) {
        /* Get hash entry with checksums for this block */
        const e = z.blockhashes[b];

        /* Enter checksums */
        e.checksum = checksum;
        e.r.a = r.a & z.rsum_a_mask;
        e.r.b = r.b;

        /* New checksums invalidate any existing checksum hash tables */
        if (z.rsum_hash != null) {
            z.rsum_hash = [];
            z.bithash = null;
        }
    }
}

/* build_hash(self)
 * Build hash tables to quickly lookup a block based on its rsum value.
 */
export function build_hash(z: rcksum_state): void {
    let id: number;
    let i = 16;

    /* Try hash size of 2^i; step down the value of i until we find a good size
     */
    while ((2 << (i - 1)) > z.blocks && i > 4) {
        i--;
    }

    /* Allocate hash based on rsum */
    z.hashmask = (2 << i) - 1;
    z.rsum_hash = [];
    for (let j = 0; j < z.hashmask + 1; j++) {
        z.rsum_hash.push(null);
    }

    /* Allocate bit-table based on rsum */
    z.bithashmask = (2 << (i + BITHASHBITS)) - 1;
    z.bithash = new Uint8Array(z.bithashmask + 1);

    /* Now fill in the hash tables.
     * Minor point: We do this in reverse order, because we're adding entries
     * to the hash chains by prepending, so if we iterate over the data in
     * reverse then the resulting hash chains have the blocks in normal order.
     * That's improves our pattern of I/O when writing out identical blocks
     * once we are processing data; we will write them in order. */
    for (id = z.blocks; id > 0;) {
        /* Decrement the loop variable here, and get the hash entry. */
        const e: hash_entry = z.blockhashes[--id];

        /* Prepend to linked list for this hash entry */
        const h: number = calc_rhash(z, z.blockhashes, id);
        e.next = z.rsum_hash[h & z.hashmask];
        z.rsum_hash[h & z.hashmask] = e;

        /* And set relevant bit in the bithash to 1 */
        z.bithash[(h & z.bithashmask) >> 3] |= 1 << (h & 7);
    }
}

/* remove_block_from_hash(self, block_id)
 * Remove the given data block from the rsum hash table, so it won't be
 * returned in a hash lookup again (e.g. because we now have the data)
 */
export function remove_block_from_hash(z: rcksum_state, id: number): void {
    const t: hash_entry = z.blockhashes[id];

    if (z.rsum_hash == null) {
        throw new Error("rsum_hash is null");
    }
    let p: hash_entry | null = z.rsum_hash[calc_rhash(z, z.blockhashes, id) & z.hashmask];

    while (p != null) {
        if (p === t) {
            if (t === z.rover) {
                z.rover = t.next;
            }
            p = p.next;
            return;
        } else {
            p = p.next;
        }
    }
}
