import { readFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";

import { createServer, Server } from "https";

import { createSignedCertificateKeyPair, ServerCertificateSet } from "./cert";

export type TestServer = {
    baseUrl: string;
    close: () => void;
    ca: string;
};

interface Range {
    start: number;
    end: number;
    size: number;
    header: string;
}

function parseRange(range: string, len: number): Range[] {
    const [ unit, ranges ] = range.split("=");
    if (unit !== "bytes") {
        throw new Error("Only supports bytes ranges");
    }
    return ranges.split(",").map(range => {
        const [ startString, endString ] = range.trim().split("-");
        const start = Number(startString);
        const end = endString === "" ? len : Number(endString);
        const size = end - start + 1;
        const header = `bytes ${start}-${end}/${size}`;
        return {
            start,
            end,
            size,
            header
        };
    });
}

export function serveStatic(directory: string) {
    return async function<T extends IncomingMessage>(req: T, res: ServerResponse<T>): Promise<void> {
        try {
            const file = `${directory}/${req.url}`;
            const data = await readFile(file);
            const len = data.length;
            const range = req.headers.range;
            if (range == null) {
                res.writeHead(200, {
                    "Content-Length": len
                });
                res.write(data);
            } else {
                const ranges = parseRange(range, len);
                if (ranges.length === 1) {
                    const range = ranges[0];
                    res.writeHead(206, {
                        "Content-Length": range.size,
                        "Content-Range": range.header
                    });
                    res.write(data.subarray(range.start, range.end + 1));
                } else {
                    const boundary = "3d6b6a416f9b5";
                    res.writeHead(206, {
                        "Content-Type": `multipart/byteranges; boundary=${boundary}`,
                        "Content-Length": ranges.reduce((len, range) => len + boundary.length + 3
                            + range.header.length + 17 + range.size + 1, 0)
                    });
                    for (const range of ranges) {
                        res.write(`--${boundary}\nContent-Range: ${range.header}\n\n`);
                        res.write(data.subarray(range.start, range.end + 1));
                        res.write("\n");
                    }
                }
            }
        } catch (e) {
            if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
                res.writeHead(404, "Not Found");
            } else {
                res.writeHead(500, String(e));
            }
        }
        res.end();
    };
}

async function listen(port: number, directory: string, keyPair: ServerCertificateSet): Promise<Server> {
    const serve = serveStatic(directory);
    return new Promise<Server>((resolve, reject) => {
        const server = createServer(keyPair,
                async (req, res) => {
                    if (req.url != null && req.url.startsWith("/redirect/")) {
                        const status = Number(req.url.substring(10, 13));
                        const realUrl = req.url.substring(13);
                        if (realUrl === "/no-location") {
                            res.writeHead(status);
                        } else {
                            res.writeHead(status, {
                                Location: realUrl
                            });
                        }
                        res.end();
                    } else {
                        await serve(req, res);
                    }
                }
            )
            .listen(port, () => {
                resolve(server);
            })
            .on("error", reject);
    });
}

export async function startServer(directory: string): Promise<TestServer> {
    const keyPair = await createSignedCertificateKeyPair();
    let retries = 5;
    while (true) {
        const port = 1024 + Math.floor(Math.random() * 64511);
        try {
            const server = await listen(port, directory, keyPair);
            return {
                baseUrl: `https://localhost:${port}`,
                close: (): void => { server.close(); },
                ca: keyPair.ca
            };
        } catch (e) {
            if (retries > 0) {
                retries--;
            } else {
                throw e;
            }
        }
    }
}
