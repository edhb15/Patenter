import jwt from "jsonwebtoken";
import { env } from "../config/env";

type AccessTokenPayload = {
  sub: string;
  email: string;
};

export const jwtUtils = {
  signAccessToken(payload: AccessTokenPayload) {
    return jwt.sign(payload, env.jwt.accessSecret, {
      expiresIn: "15m",
    });
  },

  verifyAccessToken(token: string) {
    return jwt.verify(token, env.jwt.accessSecret);
  },
};