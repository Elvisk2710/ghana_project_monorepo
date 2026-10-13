import { Injectable, Logger } from '@nestjs/common';
import { createConnection } from 'net';

export interface ScanResult {
  clean: boolean;
  detail: string;
  /** Content type established from the bytes, not from what the client claimed. */
  detectedType?: string;
}

/** Throws (fail closed) when the scan cannot be completed. */
export abstract class VirusScanner {
  abstract scan(data: Buffer, filename: string, claimedType: string): Promise<ScanResult>;
}

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_CASE = 5;

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Evidence types a citizen may attach. Everything else is rejected, whatever the extension says. */
const SIGNATURES: { type: string; ext: string[]; match: (b: Buffer) => boolean }[] = [
  { type: 'application/pdf', ext: ['pdf'], match: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { type: 'image/png', ext: ['png'], match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', ext: ['jpg', 'jpeg'], match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

export const ALLOWED_TYPES = SIGNATURES.map((s) => s.type);

// Active content that has no place in citizen evidence.
const PDF_ACTIVE = [/\/JavaScript\b/, /\/JS\b/, /\/Launch\b/, /\/OpenAction\b/, /\/EmbeddedFile\b/, /\/AA\b/, /\/RichMedia\b/];

/** Removes path components and control characters so a filename can never act as a path or header. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/^\.+/, '').trim();
  return (clean || 'attachment').slice(0, 120);
}

/**
 * Built-in checks: type established from magic bytes (must match the claimed type and the
 * extension), size cap, the EICAR test signature, and active content in PDFs.
 * This is NOT an antivirus engine. Set CLAMD_HOST to add ClamAV on top (ClamdScanner).
 */
export function basicScan(data: Buffer, filename: string, claimedType: string): ScanResult {
  if (data.length === 0) return { clean: false, detail: 'empty file' };
  if (data.length > MAX_ATTACHMENT_BYTES) return { clean: false, detail: 'file too large' };
  const sig = SIGNATURES.find((s) => s.match(data));
  if (!sig) return { clean: false, detail: 'file type not allowed (PDF, PNG or JPEG only)' };
  if (sig.type !== claimedType) return { clean: false, detail: 'declared type does not match file content' };
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!sig.ext.includes(ext)) return { clean: false, detail: 'file extension does not match file content' };
  const text = data.toString('latin1');
  if (text.includes(EICAR)) return { clean: false, detail: 'malware signature detected (EICAR test file)' };
  if (sig.type === 'application/pdf' && PDF_ACTIVE.some((re) => re.test(text))) {
    return { clean: false, detail: 'PDF contains active or embedded content' };
  }
  return { clean: true, detail: 'passed built-in checks', detectedType: sig.type };
}

/** Streams the file to a clamd daemon (INSTREAM). Any connection problem rejects. */
export function clamdScan(host: string, port: number, data: Buffer, timeoutMs = 15_000): Promise<{ infected: boolean; detail: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error('clamd timeout'));
    });
    socket.on('error', reject);
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      if (/OK$/.test(reply)) return resolve({ infected: false, detail: 'clamd: OK' });
      if (/FOUND$/.test(reply)) return resolve({ infected: true, detail: reply.replace(/^stream:\s*/, '') });
      reject(new Error(`unexpected clamd reply: ${reply}`));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += 64 * 1024) {
        const part = data.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

@Injectable()
export class DefaultVirusScanner extends VirusScanner {
  private readonly logger = new Logger(DefaultVirusScanner.name);

  async scan(data: Buffer, filename: string, claimedType: string): Promise<ScanResult> {
    const basic = basicScan(data, filename, claimedType);
    if (!basic.clean) return basic;
    const host = process.env.CLAMD_HOST;
    if (!host) return basic;
    // Configured engine must answer; if it cannot, the upload is refused rather than let through.
    const r = await clamdScan(host, Number(process.env.CLAMD_PORT ?? 3310), data);
    if (r.infected) {
      this.logger.warn(`Attachment rejected by clamd: ${r.detail}`);
      return { clean: false, detail: `malware detected: ${r.detail}` };
    }
    return { ...basic, detail: `${basic.detail}; ${r.detail}` };
  }
}
