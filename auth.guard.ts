import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Any authenticated user. Attach with @UseGuards(JwtAuthGuard). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

/** Authenticated AND flagged as an admin. Attach with
 *  @UseGuards(JwtAuthGuard, AdminGuard) — order matters, JwtAuthGuard must
 *  run first so req.user exists. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!req.user?.isAdmin) {
      throw new ForbiddenException('Admin access required.');
    }
    return true;
  }
}
