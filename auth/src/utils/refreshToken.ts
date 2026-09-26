import crypto from "crypto";

export const refreshTokenUtils = {
  generate() {
    return crypto.randomBytes(32).toString("hex");
  },

  hash(token: string) {
    return crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");
  },
};