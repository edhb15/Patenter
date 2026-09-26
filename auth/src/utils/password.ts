import argon2 from "argon2";

export const passwordUtils = {
  hash(password: string) {
    return argon2.hash(password, {
      type: argon2.argon2id,
    });
  },

  verify(hash: string, password: string) {
    return argon2.verify(hash, password);
  },
};