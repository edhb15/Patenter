import { Router, Response, CookieOptions } from "express";
import { authService } from "../services/authService";
import { AppError } from "../errors/AppError";
import { authenticate } from "../middleware/auth";
import { registerSchema, loginSchema } from "../schemas/auth";
import { loginLimiter, registerLimiter, refreshLimiter } from "../middleware/rateLimit";
import { env } from "../config/env";

const router = Router();

const REFRESH_COOKIE = "refreshToken";

// Only sent to /auth/* — the refresh token is never needed anywhere else.
const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: "strict",
  path: "/auth",
};

function setRefreshCookie(res: Response, token: string, expires: Date) {
  res.cookie(REFRESH_COOKIE, token, { ...refreshCookieOptions, expires });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
}

router.post("/register", registerLimiter, async (req, res) => {
  const { email, password } = registerSchema.parse(req.body);

  const user = await authService.register({
    email,
    password,
  });

  return res.status(201).json(user);
});

router.get("/me", authenticate, (req, res) => {
  const user = req.user;

  if (!user) {
    throw new AppError("Unauthorized", 401);
  }

  return res.json({
    id: user.id,
    email: user.email,
  });
});

router.post("/login", loginLimiter, async (req, res) => {
  const credentials = loginSchema.parse(req.body);

  const result = await authService.login(credentials);

  setRefreshCookie(res, result.refreshToken, result.expiresAt);

  return res.json({
    accessToken: result.accessToken,
  });
});

router.post("/refresh", refreshLimiter, async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE];

  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new AppError("Refresh token missing", 401);
  }

  try {
    const result = await authService.refresh(refreshToken);

    setRefreshCookie(res, result.refreshToken, result.expiresAt);

    return res.json({
      accessToken: result.accessToken,
    });
  } catch (err) {
    // A dead token is useless to the browser; drop it.
    if (err instanceof AppError && err.statusCode === 401) {
      clearRefreshCookie(res);
    }
    throw err;
  }
});

router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE];

  if (typeof refreshToken === "string" && refreshToken) {
    await authService.logout(refreshToken);
  }

  clearRefreshCookie(res);

  return res.sendStatus(204);
});

// Ends every session of the signed-in user, on all devices.
router.post("/logout-all", authenticate, async (req, res) => {
  await authService.logoutAll(req.user!.id);

  clearRefreshCookie(res);

  return res.sendStatus(204);
});

export default router;
