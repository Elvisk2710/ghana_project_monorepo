import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness: database reachable and stored as UTF-8. Questions, Hansard text and Ghanaian-language
   * names (for example the Twi letters ɛ and ɔ) cannot be stored in a single-byte encoding.
   */
  @Get('ready')
  async ready() {
    try {
      const [row] = await this.prisma.$queryRaw<{ enc: string }[]>`SELECT current_setting('server_encoding') AS enc`;
      if (row?.enc !== 'UTF8') throw new Error(`database encoding is ${row?.enc}`);
      return { status: 'ok', database: 'up' };
    } catch (e) {
      const encoding = /encoding/.test((e as Error).message);
      throw new ServiceUnavailableException({ status: 'unavailable', database: encoding ? 'must use UTF8 encoding' : 'down' });
    }
  }
}
