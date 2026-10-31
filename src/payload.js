/* SPDX-License-Identifier: GPL-2.0-or-later */
// Clipboard payload handling is deliberately independent of Shell UI.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: false});
export const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain;charset=UTF-8',
    'text/plain', 'UTF8_STRING', 'TEXT', 'STRING'];
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'image/bmp', 'image/tiff'];
export const FILE_MIMES = ['x-special/gnome-copied-files', 'text/uri-list'];
export const RICH_MIMES = ['text/html', 'text/rtf', 'application/rtf'];
const SENSITIVE_MIMES = new Set(['x-kde-passwordmanagerhint',
    'application/x-kde-passwordmanagerhint', 'application/x-keepassxc',
    'application/x-gpaste-sensitive', 'application/x-clipman-sensitive']);

export function isSensitive(mimes) {
    return mimes.some(mime => SENSITIVE_MIMES.has(mime.toLowerCase()));
}

export function selectMimes(offered) {
    // Keep one lossless text and image encoding, plus rich text and real file data.
    // This avoids asking an application to re-encode the same large image six times.
    const available = new Set(offered);
    const selected = [];
    for (const group of [TEXT_MIMES, IMAGE_MIMES]) {
        const best = group.find(mime => available.has(mime));
        if (best)
            selected.push(best);
    }
    for (const mime of [...FILE_MIMES, ...RICH_MIMES]) {
        if (available.has(mime))
            selected.push(mime);
    }
    return selected;
}

export function decodeText(bytes, mime = '') {
    if (mime === 'STRING')
        return Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    return decoder.decode(bytes).replace(/\0+$/u, '');
}

export function parseFileUris(text, copiedFiles = false) {
    const lines = text.replace(/\r\n/gu, '\n').split('\n');
    if (copiedFiles && /^(copy|cut)$/u.test(lines[0]))
        lines.shift();
    return [...new Set(lines.map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && /^[a-z][a-z0-9+.-]*:\/\//iu.test(line)))];
}

function plainFromHtml(html) {
    // Conservative, linear fallback for providers which offer HTML but no text.
    // A wildcard regex for script/style bodies rescans unmatched opening tags
    // quadratically, so clipboard-controlled markup must use a forward scan.
    const lower = html.toLowerCase();
    const pieces = [];
    let cursor = 0;
    while (cursor < html.length) {
        const opening = html.indexOf('<', cursor);
        if (opening < 0) {
            pieces.push(html.slice(cursor));
            break;
        }
        pieces.push(html.slice(cursor, opening));
        if (html.startsWith('<!--', opening)) {
            const end = html.indexOf('-->', opening + 4);
            cursor = end < 0 ? html.length : end + 3;
            continue;
        }
        const end = html.indexOf('>', opening + 1);
        if (end < 0) {
            // Preserve literal '<' in malformed text instead of dropping it.
            pieces.push(html.slice(opening));
            break;
        }
        const body = html.slice(opening + 1, end);
        const match = /^\/?\s*([a-z][a-z0-9]*)/iu.exec(body);
        const name = match?.[1].toLowerCase();
        const closing = /^\s*\//u.test(body);
        cursor = end + 1;
        if (!closing && (name === 'script' || name === 'style')) {
            let close = lower.indexOf(`</${name}`, cursor);
            while (close >= 0 && !/[\s>]/u.test(lower[close + name.length + 2] ?? ''))
                close = lower.indexOf(`</${name}`, close + name.length + 2);
            const closeEnd = close < 0 ? -1 : html.indexOf('>', close + name.length + 2);
            cursor = closeEnd < 0 ? html.length : closeEnd + 1;
        } else if (name === 'br' || (closing && ['p', 'div', 'li'].includes(name))) {
            pieces.push('\n');
        }
    }
    const entities = {'&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&'};
    return pieces.join('').replace(/&(?:nbsp|lt|gt|quot|apos|amp|#(?:x[0-9a-f]+|[0-9]+));/giu, entity => {
        const named = entities[entity.toLowerCase()];
        if (named !== undefined)
            return named;
        const hex = entity[2].toLowerCase() === 'x';
        const codePoint = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        return codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff) ?
            String.fromCodePoint(codePoint) : '\ufffd';
    });
}

export function normalizeCapture(raw) {
    const representations = {};
    const textMime = TEXT_MIMES.find(mime => raw[mime]);
    let text = textMime ? decodeText(raw[textMime], textMime) : '';
    let files = [];
    if (raw['x-special/gnome-copied-files'])
        files = parseFileUris(decodeText(raw['x-special/gnome-copied-files']), true);
    else if (raw['text/uri-list']) {
        const uris = parseFileUris(decodeText(raw['text/uri-list']));
        if (uris.some(uri => !/^https?:/iu.test(uri)))
            files = uris;
        else if (!text && uris.length)
            text = uris.join('\n');
    }
    if (files.some(uri => !/^file:\/\//iu.test(uri)))
        return null; // Remote Nautilus backends are deliberately unsupported.
    if (files.length) {
        // Never replay a historical cut/move. All three formats agree on COPY.
        representations['x-special/gnome-copied-files'] = encoder.encode(`copy\n${files.join('\n')}`);
        representations['text/uri-list'] = encoder.encode(`${files.join('\r\n')}\r\n`);
        text = files.map(uri => {
            try { return decodeURIComponent(uri.replace(/^file:\/\//u, '')); }
            catch { return uri; }
        }).join('\n');
    } else {
        for (const mime of RICH_MIMES) {
            if (raw[mime])
                representations[mime] = raw[mime];
        }
        if (!text && raw['text/html'])
            text = plainFromHtml(decodeText(raw['text/html']));
        if (raw['text/uri-list'])
            representations['text/uri-list'] = raw['text/uri-list'];
        const imageMime = IMAGE_MIMES.find(mime => raw[mime]);
        if (imageMime)
            representations[imageMime] = raw[imageMime];
    }
    if (text) {
        const bytes = encoder.encode(text);
        representations['text/plain'] = bytes;
        representations['text/plain;charset=utf-8'] = bytes;
    }
    const image = IMAGE_MIMES.some(mime => representations[mime]);
    // RTF's embedded objects and code pages need a full parser. Retain raw RTF
    // only when its provider also supplies a usable plain/HTML fallback.
    if (!Object.keys(representations).length || (!files.length && !image && !text))
        return null;
    return {kind: files.length ? 'files' : image ? 'image' : 'text', text, files, representations};
}
