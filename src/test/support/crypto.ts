import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export async function sha1(filename: string): Promise<string> {
    const size = 4096;
    const shasum = createHash("sha1");
    const buffer = new Uint8Array(size);
    let offset = 0;
    const file = await open(filename, "r");
    try {
        while (true) {
            const { bytesRead } = await file.read(buffer, 0, size, offset);
            if (bytesRead === 0) {
                break;
            }
            shasum.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
    } finally {
        await file.close();
    }
    return shasum.digest("hex");
}
