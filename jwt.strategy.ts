import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      // Fail loudly at startup rather than silently running with a
      // predictable/missing secret — this app moves real money.
      throw new Error('JWT_SECRET environment variable is required.');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: { sub: string; isAdmin: boolean }) {
    // Whatever is returned here becomes `req.user` in controllers.
    return { id: payload.sub, isAdmin: payload.isAdmin };
  }
}
