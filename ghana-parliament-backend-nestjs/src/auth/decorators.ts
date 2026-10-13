import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Principal } from './principal';

export const IS_PUBLIC = 'isPublic';
/** Marks a route as reachable without authentication (public API surface only). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal | undefined => {
  return ctx.switchToHttp().getRequest().principal;
});
