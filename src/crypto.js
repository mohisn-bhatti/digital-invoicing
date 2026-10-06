// AES-256-GCM for tenant FBR tokens. Stored format: base64(iv).base64(tag).base64(ciphertext)
const crypto = require('crypto');

function key() {
    const hex = process.env.ENCRYPTION_KEY || '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('ENCRYPTION_KEY must be 64 hex characters (run: npm run gen:keys)');
    }
    return Buffer.from(hex, 'hex');
}

function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

function decrypt(stored) {
    const [iv, tag, enc] = stored.split('.').map(s => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function mask(plain) {
    return plain ? '••••' + plain.slice(-4) : '';
}

module.exports = { encrypt, decrypt, mask };
