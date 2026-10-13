import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface AlfrescoNode {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
}

export abstract class RepositoryClient {
  abstract listFolder(folderId?: string): Promise<AlfrescoNode[]>;
  abstract getNode(nodeId: string): Promise<AlfrescoNode>;
  abstract download(nodeId: string): Promise<Buffer>;
  abstract upload(name: string, data: Buffer, mimeType: string, folderId?: string): Promise<AlfrescoNode>;
}

/**
 * Server-side Alfresco adapter (T-025). The browser never talks to Alfresco and never
 * holds credentials: this service authenticates with credentials from the server
 * environment and exchanges them for a short-lived ticket.
 */
@Injectable()
export class AlfrescoClient extends RepositoryClient {
  private readonly logger = new Logger(AlfrescoClient.name);
  private ticket?: { value: string; at: number };
  private readonly TICKET_TTL_MS = 30 * 60_000;

  private cfg() {
    const baseUrl = process.env.ALFRESCO_BASE_URL;
    const user = process.env.ALFRESCO_USER;
    const password = process.env.ALFRESCO_PASSWORD;
    if (!baseUrl || !user || !password) throw new ServiceUnavailableException('Document repository is not configured');
    return { baseUrl: baseUrl.replace(/\/$/, ''), user, password, folder: process.env.ALFRESCO_FOLDER_ID ?? '-root-' };
  }

  private api(path: string) {
    return `${this.cfg().baseUrl}/alfresco/api/-default-/public/alfresco/versions/1${path}`;
  }

  private async authHeader(force = false): Promise<Record<string, string>> {
    if (!force && this.ticket && Date.now() - this.ticket.at < this.TICKET_TTL_MS) return this.basic(this.ticket.value);
    const { baseUrl, user, password } = this.cfg();
    const res = await fetch(`${baseUrl}/alfresco/api/-default-/public/authentication/versions/1/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user, password }),
    }).catch((e) => {
      throw new BadGatewayException(`Repository unreachable: ${e.message}`);
    });
    if (!res.ok) {
      this.logger.error(`Alfresco authentication failed with status ${res.status}`);
      throw new BadGatewayException('Repository authentication failed');
    }
    const body: any = await res.json();
    this.ticket = { value: body.entry.id, at: Date.now() };
    return this.basic(this.ticket.value);
  }

  private basic(ticket: string) {
    return { Authorization: `Basic ${Buffer.from(ticket).toString('base64')}` };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res = await fetch(this.api(path), { ...init, headers: { ...(init.headers as any), ...(await this.authHeader()) } }).catch((e) => {
      throw new BadGatewayException(`Repository unreachable: ${e.message}`);
    });
    if (res.status === 401) {
      res = await fetch(this.api(path), { ...init, headers: { ...(init.headers as any), ...(await this.authHeader(true)) } });
    }
    if (res.status === 404) throw new BadGatewayException('Repository node not found');
    if (!res.ok) throw new BadGatewayException(`Repository error ${res.status}`);
    return res;
  }

  private toNode(e: any): AlfrescoNode {
    return { id: e.id, name: e.name, mimeType: e.content?.mimeType, size: e.content?.sizeInBytes, modifiedAt: e.modifiedAt };
  }

  async listFolder(folderId = this.cfg().folder): Promise<AlfrescoNode[]> {
    const res = await this.request(`/nodes/${encodeURIComponent(folderId)}/children?where=(isFile=true)&maxItems=200`);
    const body: any = await res.json();
    return body.list.entries.map((x: any) => this.toNode(x.entry));
  }

  async getNode(nodeId: string): Promise<AlfrescoNode> {
    const res = await this.request(`/nodes/${encodeURIComponent(nodeId)}`);
    return this.toNode(((await res.json()) as any).entry);
  }

  async download(nodeId: string): Promise<Buffer> {
    const res = await this.request(`/nodes/${encodeURIComponent(nodeId)}/content`);
    return Buffer.from(await res.arrayBuffer());
  }

  async upload(name: string, data: Buffer, mimeType: string, folderId = this.cfg().folder): Promise<AlfrescoNode> {
    const form = new FormData();
    form.append('filedata', new Blob([data], { type: mimeType }), name);
    form.append('name', name);
    form.append('nodeType', 'cm:content');
    form.append('autoRename', 'true');
    const res = await this.request(`/nodes/${encodeURIComponent(folderId)}/children`, { method: 'POST', body: form });
    return this.toNode(((await res.json()) as any).entry);
  }
}
