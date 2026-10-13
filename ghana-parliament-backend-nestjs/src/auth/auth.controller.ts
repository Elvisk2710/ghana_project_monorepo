import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { rate } from '../common/rate';
import { Public } from './decorators';
import { LocalAuthService } from './local-auth';

@Controller('auth')
export class AuthController {
  constructor(private readonly local: LocalAuthService) {}

  /** Email-and-password sign-in for the admin console. Returns a short-lived bearer token. */
  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle(rate(10))
  login(@Body() body: { email?: unknown; password?: unknown }) {
    if (typeof body?.email !== 'string' || typeof body?.password !== 'string' || !body.email || !body.password || body.password.length > 200) {
      throw new BadRequestException('Email and password are required');
    }
    return this.local.login(body.email, body.password);
  }
}
