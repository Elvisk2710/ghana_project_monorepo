import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type MatchKind = 'exact_name' | 'code' | 'alias' | 'starts_with' | 'contains';

export interface ConstituencyMatch {
  constituency: { id: string; code: string; name: string; region: string };
  matchedOn: MatchKind;
  /** Human-readable explanation of how the match was made (Journey C step 2). */
  explanation: string;
  mp: PublicMp | null;
}

export interface PublicMp {
  id: string;
  name: string;
  party: string;
  roleTitle: string | null;
  contact: unknown;
  since: string;
}

export const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export interface Candidate {
  id: string;
  code: string;
  name: string;
  region: string;
  aliases: string[];
}

const RANK: Record<MatchKind, number> = { exact_name: 0, code: 1, alias: 2, starts_with: 3, contains: 4 };

/**
 * Pure matcher over the approved constituency list. Never guesses: a query with no
 * recognised name, code or alias returns no matches, and a partial match is labelled as one.
 */
export function matchConstituencies(query: string, list: Candidate[]): { c: Candidate; kind: MatchKind; via?: string }[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const out: { c: Candidate; kind: MatchKind; via?: string }[] = [];
  for (const c of list) {
    const name = norm(c.name);
    if (name === q) out.push({ c, kind: 'exact_name' });
    else if (norm(c.code) === q) out.push({ c, kind: 'code' });
    else {
      const alias = c.aliases.find((a) => norm(a) === q);
      if (alias) out.push({ c, kind: 'alias', via: alias });
      else if (name.startsWith(q)) out.push({ c, kind: 'starts_with' });
      else if (q.length >= 3 && (name.includes(q) || c.aliases.some((a) => norm(a).includes(q)))) out.push({ c, kind: 'contains' });
    }
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.c.name.localeCompare(b.c.name));
}

function explain(kind: MatchKind, name: string, query: string, via?: string): string {
  switch (kind) {
    case 'exact_name': return `You searched for "${query}", which is the official name of the ${name} constituency.`;
    case 'code': return `"${query}" is the official code of the ${name} constituency.`;
    case 'alias': return `"${via}" is a recorded alternative name for the ${name} constituency.`;
    case 'starts_with': return `"${query}" is the start of the constituency name ${name}. Check this is the right one.`;
    case 'contains': return `"${query}" appears in the constituency name or recorded alternative names for ${name}. This is a partial match: check it is the right one.`;
  }
}

export interface ConstituencyImportRow {
  code: string;
  name: string;
  region: string;
  aliases?: string[];
}

@Injectable()
export class DirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  private toPublicMp(m: { id: string; officialName: string; party: string; roleTitle: string | null; publicContact: Prisma.JsonValue; activeFrom: Date }): PublicMp {
    return { id: m.id, name: m.officialName, party: m.party, roleTitle: m.roleTitle, contact: m.publicContact, since: m.activeFrom.toISOString().slice(0, 10) };
  }

  private currentMp(constituencyId: string) {
    const now = new Date();
    return this.prisma.mp.findFirst({
      where: { constituencyId, isPublished: true, activeFrom: { lte: now }, OR: [{ activeTo: null }, { activeTo: { gt: now } }] },
      orderBy: { activeFrom: 'desc' },
    });
  }

  async listConstituencies(region?: string) {
    return this.prisma.constituency.findMany({
      where: { isActive: true, ...(region ? { region } : {}) },
      select: { id: true, code: true, name: true, region: true },
      orderBy: [{ region: 'asc' }, { name: 'asc' }],
    });
  }

  async regions(): Promise<string[]> {
    const rows = await this.prisma.constituency.findMany({ where: { isActive: true }, distinct: ['region'], select: { region: true }, orderBy: { region: 'asc' } });
    return rows.map((r) => r.region);
  }

  async lookup(query: string): Promise<{ query: string; matches: ConstituencyMatch[] }> {
    const list = await this.prisma.constituency.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true, region: true, aliases: true } });
    const found = matchConstituencies(query, list).slice(0, 10);
    const matches: ConstituencyMatch[] = [];
    for (const f of found) {
      const mp = await this.currentMp(f.c.id);
      matches.push({
        constituency: { id: f.c.id, code: f.c.code, name: f.c.name, region: f.c.region },
        matchedOn: f.kind,
        explanation: explain(f.kind, f.c.name, query.trim(), f.via),
        mp: mp ? this.toPublicMp(mp) : null,
      });
    }
    return { query, matches };
  }

  async getPublic(id: string) {
    const c = await this.prisma.constituency.findFirst({ where: { id, isActive: true }, select: { id: true, code: true, name: true, region: true } }).catch(() => null);
    if (!c) throw new NotFoundException('Constituency not found');
    const mp = await this.currentMp(c.id);
    return { constituency: c, mp: mp ? this.toPublicMp(mp) : null };
  }

  // ---------- Internal ----------

  listMps() {
    return this.prisma.mp.findMany({ include: { constituency: { select: { code: true, name: true } } }, orderBy: { officialName: 'asc' } });
  }

  async saveMp(id: string | null, data: { officialName?: string; party?: string; roleTitle?: string | null; publicContact?: Prisma.InputJsonValue; constituencyId?: string; activeFrom?: Date; activeTo?: Date | null; isPublished?: boolean; userId?: string | null }) {
    if (id === null) {
      if (!data.officialName || !data.party || !data.constituencyId || !data.activeFrom) throw new BadRequestException('officialName, party, constituencyId and activeFrom are required');
      return this.prisma.mp.create({ data: { ...(data as Required<Pick<typeof data, 'officialName' | 'party' | 'constituencyId' | 'activeFrom'>>), roleTitle: data.roleTitle ?? undefined, publicContact: data.publicContact, activeTo: data.activeTo ?? undefined, isPublished: data.isPublished ?? false, userId: data.userId ?? undefined } });
    }
    try {
      return await this.prisma.mp.update({ where: { id }, data: { ...data, publicContact: data.publicContact } });
    } catch (e: any) {
      if (e?.code === 'P2025') throw new NotFoundException('MP not found');
      throw e;
    }
  }

  /**
   * Boundary-change process (T-049). Applies an approved list: new codes are added, changed
   * names/regions/aliases updated, and constituencies absent from the list are deactivated
   * (never deleted, so historic cases keep their routing). `dryRun` reports without writing.
   */
  async importConstituencies(rows: ConstituencyImportRow[], sourceRef: string, dryRun: boolean) {
    const codes = new Set<string>();
    for (const r of rows) {
      if (!r.code || !r.name || !r.region) throw new BadRequestException('Every row needs code, name and region');
      if (codes.has(r.code)) throw new BadRequestException(`Duplicate code in import: ${r.code}`);
      codes.add(r.code);
    }
    const existing = await this.prisma.constituency.findMany();
    const byCode = new Map(existing.map((c) => [c.code, c]));
    const added: string[] = [];
    const updated: string[] = [];
    const reactivated: string[] = [];
    const deactivated: string[] = [];
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const r of rows) {
      const cur = byCode.get(r.code);
      const aliases = r.aliases ?? [];
      if (!cur) {
        added.push(r.code);
        ops.push(this.prisma.constituency.create({ data: { code: r.code, name: r.name, region: r.region, aliases, sourceRef } }));
      } else {
        const changed = cur.name !== r.name || cur.region !== r.region || JSON.stringify(cur.aliases) !== JSON.stringify(aliases);
        if (!cur.isActive) reactivated.push(r.code);
        if (changed) updated.push(r.code);
        if (changed || !cur.isActive) ops.push(this.prisma.constituency.update({ where: { id: cur.id }, data: { name: r.name, region: r.region, aliases, isActive: true, sourceRef } }));
      }
    }
    for (const c of existing) {
      if (c.isActive && !codes.has(c.code)) {
        deactivated.push(c.code);
        ops.push(this.prisma.constituency.update({ where: { id: c.id }, data: { isActive: false, sourceRef } }));
      }
    }
    // Open cases on a deactivated constituency need a human to reroute them.
    const openCases = deactivated.length
      ? await this.prisma.citizenCase.count({ where: { constituency: { code: { in: deactivated } }, status: { not: 'CLOSED' } } })
      : 0;
    if (!dryRun) await this.prisma.$transaction(ops);
    return { dryRun, sourceRef, added, updated, reactivated, deactivated, openCasesNeedingReroute: openCases };
  }
}
