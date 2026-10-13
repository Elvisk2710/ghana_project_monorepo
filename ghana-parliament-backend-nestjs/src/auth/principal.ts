import type { Role } from '@prisma/client';

/** The authenticated caller. Roles and scopes come from the database, never from the token. */
export interface Principal {
  userId: string;
  externalId: string;
  email: string;
  roles: Role[];
  /** Constituencies this user may act on (assigned staff constituencies plus the MP's own). */
  constituencyIds: string[];
}
