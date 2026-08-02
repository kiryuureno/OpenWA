import { createHash } from 'crypto';

/**
 * Stable, non-reversible fingerprint of an outbound payload, used by the stealth guard's
 * repeated-content detection: blasting the exact same text/media to many distinct chats in a short
 * window is one of WhatsApp's strongest spam signals, so the guard counts how many distinct chats
 * received each fingerprint and throttles when it spreads too fast.
 *
 * Hashed, never stored verbatim: the guard window must not become a second copy of outbound
 * content. Media is fingerprinted on at most the first 4 KiB of its base64 so a large payload does
 * not pay a full hashing pass (collisions across identical prefixes are acceptable — identical
 * files are exactly what we want to cluster).
 */
export function contentFingerprint(...parts: Array<string | undefined | null>): string {
    const hash = createHash('sha256');
    for (const part of parts) {
        if (!part) continue;
        hash.update(typeof part === 'string' && part.length > 4096 ? part.slice(0, 4096) : part);
        hash.update('');
    }
    return hash.digest('base64');
}
