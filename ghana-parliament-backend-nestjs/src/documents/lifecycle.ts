import { ConflictException } from '@nestjs/common';
import { DocumentLifecycle as L } from '@prisma/client';

/**
 * Document lifecycle state machine (Objective 2 / Journey E).
 *
 *  DRAFT -> PROCESSING -> REVIEW -> APPROVED -> PUBLISHED -> SUPERSEDED
 *  REVIEW -> REJECTED -> DRAFT (resubmit)
 *  PUBLISHED -> APPROVED is the rollback (unpublish): the record is never deleted.
 */
const TRANSITIONS: Record<L, L[]> = {
  [L.DRAFT]: [L.PROCESSING],
  [L.PROCESSING]: [L.REVIEW, L.DRAFT],
  [L.REVIEW]: [L.APPROVED, L.REJECTED, L.DRAFT],
  [L.APPROVED]: [L.PUBLISHED, L.REVIEW],
  [L.PUBLISHED]: [L.SUPERSEDED, L.APPROVED],
  [L.REJECTED]: [L.DRAFT],
  [L.SUPERSEDED]: [],
};

export function canTransition(from: L, to: L): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: L, to: L): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`Illegal document transition ${from} -> ${to}`);
  }
}

/** Only PUBLISHED documents may ever be served by public search or answers. */
export function isPubliclyVisible(lifecycle: L, isPublished: boolean): boolean {
  return lifecycle === L.PUBLISHED && isPublished;
}
