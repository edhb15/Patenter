import { AppError } from "../errors/AppError";
import { userRepository } from "../users/UserRepository";
import { passwordUtils } from "../utils/password";
import { jwtUtils } from "../utils/jwt";
import { refreshTokenUtils } from "../utils/refreshToken";
import { sessionRepository } from "../sessions/SessionRepository";

type RegisterInput = {
  email: string;
  password: string;
};

export const authService = {
    async register({ email, password }: RegisterInput) {
  
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
  
    async login({ email, password }: RegisterInput) {
      if (!email || !password) {
        throw new AppError("Email and password are required", 400);
      }
  
      const user = await userRepository.findByEmail(email);
  
      // Don't reveal whether the email or password was wrong
      if (!user) {
        throw new AppError("Invalid email or password", 401);
      }
  
      const passwordMatches = await passwordUtils.verify(
        user.passwordHash,
        password
      );

      if (!passwordMatches) {
        throw new AppError("Invalid email or password", 401);
      }

      const refreshToken = refreshTokenUtils.generate();

      const refreshTokenHash = refreshTokenUtils.hash(refreshToken);

      const expiresAt = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      );

      await sessionRepository.create({
        userId: user.id,
        refreshTokenHash,
        expiresAt,
      });

  
      const accessToken = jwtUtils.signAccessToken({
        sub: user.id,
        email: user.email,
      });
  
      return {
        accessToken,
        refreshToken,
      };
    },
    async refresh(refreshToken: string) {
      const refreshTokenHash =
        refreshTokenUtils.hash(refreshToken);
    
      const session =
        await sessionRepository.findByRefreshTokenHash(
          refreshTokenHash
        );
    
      if (!session) {
        throw new AppError(
          "Invalid refresh token",
          401
        );
      }
    
      if (session.expiresAt < new Date()) {
        throw new AppError(
          "Refresh token expired",
          401
        );
      }
      await sessionRepository.delete(session.id);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await sessionRepository.create({
      userId: session.user.id,
      refreshTokenHash,
      expiresAt,
    });

    const accessToken = jwtUtils.signAccessToken({
      sub: session.user.id,
      email: session.user.email,
    });

    return {
      accessToken,
      refreshToken,
    };
  },
  
  async logout(refreshToken: string) {
    const refreshTokenHash =
      refreshTokenUtils.hash(refreshToken);
  
    const session =
      await sessionRepository.findByRefreshTokenHash(
        refreshTokenHash
      );
  
    if (!session) {
      return;
    }
  
    await sessionRepository.delete(session.id);
  }
};