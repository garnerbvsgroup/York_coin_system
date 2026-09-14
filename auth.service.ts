import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const SALT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async register(email: string, password: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('An account with that email already exists.');

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.user.create({
        data: { email, passwordHash },
      });
      // Every user gets a wallet at signup — created empty, per genesis rules
      // (nothing is pre-circulated, balances start at 0).
      await tx.wallet.create({ data: { userId: created.id, balance: 0 } });
      await tx.authAccount.create({ data: { userId: created.id, provider: 'password' } });
      return created;
    });

    return this.issueToken(user.id, user.isAdmin);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials.');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials.');

    return this.issueToken(user.id, user.isAdmin);
  }

  private issueToken(userId: string, isAdmin: boolean) {
    const accessToken = this.jwt.sign({ sub: userId, isAdmin });
    return { accessToken, userId, isAdmin };
  }
}

// OAuth extension point (per spec: login must support multiple methods,
// e.g. Google/GitHub, from launch): add a corresponding method here that
// finds-or-creates a User + AuthAccount row with provider = 'google' (etc.)
// and provider_id = the OAuth subject id, then calls issueToken the same
// way. Not implemented in this sample — needs an actual OAuth app
// registration (client id/secret) which is a per-deployment decision.
