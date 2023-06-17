import "jest-extended";

import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";

import { zsync } from "../main/zsync";
import { ZSyncError } from "../main/ZSyncError";
import { sha1 } from "./support/crypto";
import { startServer, TestServer } from "./support/server";

const TEST_DAT_SHA1 = "b11a4adf922b03f5cb6dffa356e7de7455267f30";

describe("zsync", () => {
    const dataDir = join(__dirname, "../../src/test/data");
    let tmpDir: string;
    let server: TestServer;

    beforeAll(async () => {
        server = await startServer(dataDir);
    });

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "zsync-test"));
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true });
    });

    afterAll(() => {
        server.close();
    });

    it("downloads the whole file into current working directory", async () => {
        const currentDir = cwd();
        try {
            chdir(tmpDir);
            await zsync(`${server.baseUrl}/test.dat.zsync`, { ca: server.ca });
            const checksum = await sha1(`${tmpDir}/test.dat`);
            expect(checksum).toBe(TEST_DAT_SHA1);
        } finally {
            chdir(currentDir);
        }
    });

    it("downloads the whole file into given output file", async () => {
        const output = `${tmpDir}/output.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("downloads file with complete local seed fils", async () => {
        const output = `${tmpDir}/output.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            inputs: [
                `${dataDir}/test.dat`
            ],
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("downloads file with incomplete local seed file", async () => {
        const output = `${tmpDir}/output.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            inputs: [
                `${dataDir}/seed-start.dat`
            ],
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("downloads file with duplicate local seed files", async () => {
        const output = `${tmpDir}/output.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            inputs: [
                `${dataDir}/seed-start.dat`,
                `${dataDir}/seed-start.dat`
            ],
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("downloads file with multiple local seed files where the last seed brings no new data", async () => {
        const output = `${tmpDir}/output.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            inputs: [
                `${dataDir}/seed-start.dat`,
                `${dataDir}/seed-end.dat`,
                `${dataDir}/seed-middle.dat`
            ],
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("downloads file with multiple overlapping local seed files", async () => {
        const output = `${tmpDir}/output.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            inputs: [
                `${dataDir}/seed-start.dat`,
                `${dataDir}/seed-middle.dat`,
                `${dataDir}/seed-end.dat`
            ],
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("downloads the whole file into given output file", async () => {
        const output = `${tmpDir}/output.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("completes a partial file", async () => {
        const buffer = (await readFile(`${dataDir}/test.dat`));
        await writeFile(`${tmpDir}/test.dat`, buffer.subarray(0, buffer.byteLength / 2));
        const output = `${tmpDir}/test.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("updates a corrupt file", async () => {
        const buffer = (await readFile(`${dataDir}/test.dat`));
        buffer[buffer.length / 2] ^= 0b10101010;
        buffer[buffer.length - 11] ^= 0b10101010;
        buffer[11] ^= 0b10101010;
        await writeFile(`${tmpDir}/test.dat`, buffer);
        const output = `${tmpDir}/test.dat`;
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("does nothing when file is already complete", async () => {
        const output = `${tmpDir}/test.dat`;
        await copyFile(`${dataDir}/test.dat`, output);
        await zsync(`${server.baseUrl}/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("correctly handles HTTP 301 redirects", async () => {
        const output = `${tmpDir}/test.dat`;
        await zsync(`${server.baseUrl}/redirect/301/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("correctly handles HTTP 302 redirects", async () => {
        const output = `${tmpDir}/test.dat`;
        await zsync(`${server.baseUrl}/redirect/302/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("correctly handles HTTP 307 redirects", async () => {
        const output = `${tmpDir}/test.dat`;
        await zsync(`${server.baseUrl}/redirect/307/test.dat.zsync`, {
            output,
            ca: server.ca
        });
        const checksum = await sha1(output);
        expect(checksum).toBe(TEST_DAT_SHA1);
    });

    it("aborts when server sends redirect without Location header", async () => {
        const output = `${tmpDir}/test.dat`;
        await expect(zsync(`${server.baseUrl}/redirect/301/no-location`, {
            output,
            ca: server.ca
        })).rejects.toThrowWithMessage(ZSyncError, "HTTP redirect has no location header");
    });

    it("aborts when server sends 404", async () => {
        const output = `${tmpDir}/test.dat`;
        await expect(zsync(`${server.baseUrl}/not-existing`, {
            output,
            ca: server.ca
        })).rejects.toThrowWithMessage(ZSyncError, `HTTP request to '${server.baseUrl}/not-existing' `
            + `failed with status 404: Not Found`);
    });
});
