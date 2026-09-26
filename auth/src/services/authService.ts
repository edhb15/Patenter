import crypto from "crypto";
import { AppError } from "../errors/AppError";
import { logger } from "../config/logger";
import { userRepository } from "../users/UserRepository";
import { passwordUtils } from "../utils/password";
import { jwtUtils } from "../utils/jwt";
import { refreshTokenUtils } from "../utils/refreshToken";
import { sessionRepository } from "../sessions/SessionRepository";

type Credentials = {
  email: string;
  password: string;
};

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

// A token used again within this window is treated as a harmless race
// (e.g. two tabs refreshing at once), not as theft.
const REUSE_GRACE_MS = 10 * 1000;

// Verified when the email doesn't exist, so a login takes the same time
// whether or not the account exists.
const dummyHashPromise = passwordUtils.hash(crypto.randomBytes(32).toString("hex"));

function invalidRefreshToken() {
  return new AppError("Invalid refresh token", 401);
}

export const authService = {
    async register({ email, password }: Credentials) {
  
      const existingUser = await userRepository.findByEmail(email);
      if (existingUser) {
        throw new AppError("Email already in use", 409);
      }
  
      const passwordHash = await passwordUtils.hash(password);
  
      const user = await userRepository.create({
        email,
        passwordHash,
      });
  
      return {
        id: user.id,
        email: user.email,
      };
    },
  
    async login({ email, password }: Credentials) {
      const user = await userRepository.findByEmail(email);

      const passwordMatches = await passwordUtils.verify(
        user ? user.passwordHash : await dummyHashPromise,
        password
      );

      // Don't reveal whether the email or password was wrong
      if (!user || !passwordMatches) {
        throw new AppError("Invalid email or password", 401);
      }

      await sessionRepository.deleteExpiredForUser(user.id);

      const refreshToken = refreshTokenUtils.generate();

      const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

      await sessionRepository.create({
        userId: user.id,
        familyId: crypto.randomUUID(),
        refreshTokenHash: refreshTokenUtils.hash(refreshToken),
        expiresAt,
      });
  
      const accessToken = jwtUtils.signAccessToken({
        sub: user.id,
        email: user.email,
      });
  
      return {
        accessToken,
        refreshToken,
        expiresAt,
      };
    },

    async refresh(refreshToken: string) {
      const session =
        await sessionRepository.findByRefreshTokenHash(
          refreshTokenUtils.hash(refreshToken)
        );
    
      if (!session) {
        throw invalidRefreshToken();
      }

      if (session.revokedAt) {
        // An already-rotated token came back. Outside the short race
        // window that means someone else has a copy: end the whole login.
        if (Date.now() - session.revokedAt.getTime() > REUSE_GRACE_MS) {
          logger.warn(
            { userId: session.userId, familyId: session.familyId },
            "Refresh token reuse detected, revoking session family"
          );
          await sessionRepository.deleteFamily(session.familyId);
        }
        throw invalidRefreshToken();
      }
    
      if (session.expiresAt < new Date()) {
        await sessionRepository.deleteFamily(session.familyId);
        throw new AppError(
          "Refresh token expired",
          401
        );
      }

    // Rotate: the old token stops working and a brand-new one is issued.
    // The session keeps its original expiry, so refreshing can't extend
    // a (possibly stolen) session forever.
    const newRefreshToken = refreshTokenUtils.generate();

    const rotated = await sessionRepository.rotate({
      oldSessionId: session.id,
      userId: session.user.id,
      familyId: session.familyId,
      refreshTokenHash: refreshTokenUtils.hash(newRefreshToken),
      expiresAt: session.expiresAt,
    });

    // Another request already used this token.
    if (!rotated) {
      throw invalidRefreshToken();
    }

    const accessToken = jwtUtils.signAccessToken({
      sub: session.user.id,
      email: session.user.email,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt: session.expiresAt,
    };
  },
  
  async logout(refreshToken: string) {
    const session =
      await sessionRepository.findByRefreshTokenHash(
        refreshTokenUtils.hash(refreshToken)
      );
  
    if (!session) {
      return;
    }
  
    await sessionRepository.deleteFamily(session.familyId);
  },

  // Signs the user out on every device.
  async logoutAll(userId: string) {
    await sessionRepository.deleteAllForUser(userId);
  },
};
