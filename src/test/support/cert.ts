/*
 * Copyright (C) 2018 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */

import forge from "node-forge";

const { pki } = forge;
const { rsa } = pki;

/**
 * Pair of X.509 certificate and private key.
 */
export interface CertificateKeyPair {
    /** The X.509 certificate. */
    cert: forge.pki.Certificate;

    /** The private key. */
    key: forge.pki.PrivateKey;
}

export interface ServerCertificateSet {
    /** The X.509 certificate. */
    cert: string;

    /** The private key. */
    key: string;

    ca: string;
}

/**
 * Creates RSA key pair.
 *
 * @param options - Optional key pair generator options.
 * @return The created RSA key pair.
 */
async function createRSAKeyPair(options?: forge.pki.rsa.GenerateKeyPairOptions): Promise<forge.pki.KeyPair> {
    return new Promise<forge.pki.KeyPair>((resolve, reject) => {
        rsa.generateKeyPair(options, (error, keyPair) => {
            if (error != null) {
                reject(error);
            } else {
                resolve(keyPair);
            }
        });
    });
}

/**
 * Returns specified number of random bytes.
 *
 * @param num - The number of random bytes to generate.
 * @return The random bytes in form of a string.
 */
function getRandomBytes(num: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        forge.random.getBytes(num, (error: Error | null, bytes: string) => {
            if (error != null) {
                reject(error);
            } else {
                resolve(bytes);
            }
        });
    });
}

/**
 * Creates a certificate key pair.
 *
 * @return The created certificate key pair.
 */
export async function createCertificateKeyPair(configure?: (certificate: forge.pki.Certificate) => void,
        signKey?: forge.pki.PrivateKey): Promise<CertificateKeyPair> {
    const { privateKey, publicKey } = await createRSAKeyPair({ bits: 2048 });
    const certificate = pki.createCertificate();
    certificate.publicKey = publicKey;
    const serialNumberBytes = await getRandomBytes(20);
    certificate.serialNumber = forge.util.bytesToHex(String.fromCharCode((serialNumberBytes.charCodeAt(0) & 0x7f))
        + serialNumberBytes.substring(1));
    certificate.validity.notBefore = new Date();
    certificate.validity.notAfter = new Date();
    certificate.validity.notAfter.setFullYear(certificate.validity.notAfter.getFullYear() + 20);
    configure?.(certificate);
    certificate.sign(signKey ?? privateKey, forge.md.sha256.create());
    return { cert: certificate, key: privateKey };
}

/**
 * Creates a certificate key pair.
 *
 * @return The created certificate key pair.
 */
export async function createSignedCertificateKeyPair(): Promise<ServerCertificateSet> {
    const caKeyPair = await createCertificateKeyPair(certificate => {
        certificate.setSubject([
            { name: "commonName", value: "zsync Test CA" }
        ]);
        certificate.setIssuer(certificate.subject.attributes);
        certificate.setExtensions([
            {
                name: "basicConstraints",
                cA: true
            }, {
                name: "keyUsage",
                keyCertSign: true,
                cRLSign: true
            }
        ]);
    });
    const serverKeyPair = await createCertificateKeyPair(certificate => {
        certificate.setSubject([
            { name: "commonName", value: "localhost" }
        ]);
        certificate.setIssuer(caKeyPair.cert.subject.attributes);
        certificate.setExtensions([
            {
                name: "basicConstraints",
                cA: false
            }, {
                name: "nsCertType",
                server: true
            }, {
                name: "subjectKeyIdentifier"
            }, {
                name: "authorityKeyIdentifier",
                authorityCertIssuer: true,
                serialNumber: caKeyPair.cert.serialNumber
            }, {
                name: "keyUsage",
                digitalSignature: true,
                nonRepudiation: true,
                keyEncipherment: true
            }, {
                name: "extKeyUsage",
                serverAuth: true
            }, {
                name: "subjectAltName",
                altNames: [
                    { type: 2, value: "localhost" }
                ]
            }
        ]);
    }, caKeyPair.key);
    return {
        cert: pki.certificateToPem(serverKeyPair.cert),
        key: pki.privateKeyToPem(serverKeyPair.key),
        ca: pki.certificateToPem(caKeyPair.cert)
    };
}
