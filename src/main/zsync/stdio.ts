/*
 * Copyright (C) 2022 Klaus Reimer <k@ailis.de>
 * Copyright (C) 2004,2005,2007,2009 Colin Phipps <cph@moria.org.uk>
 * See LICENSE.md for licensing information.
 */

import type { Mode } from "node:fs";
import { FileHandle, open } from "node:fs/promises";

export type FILE = {
    readonly handle: FileHandle;
    position: number;
    closed: boolean;
    size: number;
};

export async function fopen(filename: string, flags?: string | number, mode?: Mode): Promise<FILE> {
    const handle = await open(filename, flags, mode);
    return {
        handle,
        position: 0,
        closed: false,
        size: (await handle.stat()).size
    };
}

export async function fclose(file: FILE): Promise<void> {
    await file.handle.close();
    file.closed = true;
}

export async function fread(buffer: Uint8Array, size: number, count: number, file: FILE, offset: number = 0):
        Promise<number> {
    const result = await file.handle.read(buffer, offset, size * count, file.position);
    file.position += result.bytesRead;
    return result.bytesRead / size;
}

export async function feof(file: FILE): Promise<boolean> {
    if (file.closed || file.position >= file.size) {
        return true;
    }
    const buffer = new Uint8Array(123);
    try {
        const result = await file.handle.read(buffer, 0, 1, file.position);
        return result.bytesRead === 0;
    } catch (e) {
        throw new Error("FEOF failed!");
    }
}

export async function fgets(file: FILE): Promise<string> {
    const buffer = new Uint8Array(1024);
    let i = 0;
    for (; i < 1024; i++) {
        await fread(buffer, 1, 1, file, i);
        if (buffer[i] === 0 || buffer[i] === 10 || buffer[i] === 13) {
            break;
        }
    }
    return new TextDecoder().decode(buffer.subarray(0, i));
}

export async function fwrite(buffer: Uint8Array, size: number, count: number, file: FILE, offset = 0): Promise<number> {
    const result = await file.handle.write(buffer, offset, size * count, file.position);
    file.position += result.bytesWritten;
    return result.bytesWritten / size;
}
