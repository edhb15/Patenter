import jwt from "jsonwebtoken";
import { env } from "../config/env";

export type AccessTokenPayload = {
  sub: string;
  email: string;
};

export const jwtUtils = {
  signAccessToken(payload: AccessTokenPayload) {
    return jwt.sign(payload, env.jwt.accessSecret, {
      algorithm: "HS256",
      expiresIn: "15m",
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });
  },

  verifyAccessToken(token: string) {
    return jwt.verify(token, env.jwt.accessSecret, {
      algorithms: ["HS256"],
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    }) as jwt.JwtPayload & AccessTokenPayload;
  },
};
