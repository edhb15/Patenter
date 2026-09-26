import { Router } from "express";
import { authService } from "../services/authService";
import { AppError } from "../errors/AppError";
import { authenticate } from "../middleware/auth";
import { registerSchema, loginSchema } from "../schemas/auth";
import { loginLimiter, registerLimiter } from "../middleware/rateLimit";

const router = Router();

router.post("/register", registerLimiter, async (req, res, next) => {
  try {
    const { email, password } = registerSchema.parse(req.body);

    const user = await authService.register({
      email,
      password,
    });

    return res.status(201).json(user);
  } catch (err) {
    next(err);
  }
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

  router.post("/login", loginLimiter, async (req, res, next) => {
    try {
      const result = await authService.login(req.body);
  
      res.cookie("refreshToken", result.refreshToken, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        expires: result.expiresAt,
      });
  
      return res.json({
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/refresh", async (req, res, next) => {
    try {
      const refreshToken = req.cookies.refreshToken;
  
      if (!refreshToken) {
        throw new AppError("Refresh token missing", 401);
      }
  
      const result = await authService.refresh(refreshToken);

      res.cookie("refreshToken", result.refreshToken, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        expires: result.expiresAt,
      });
  
      return res.json({
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  });
  router.post("/logout", async (req, res, next) => {
    try {
      const refreshToken = req.cookies.refreshToken;
  
      if (refreshToken) {
        await authService.logout(refreshToken);
      }
  
      res.clearCookie("refreshToken", {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
      });
  
      return res.sendStatus(204);
    } catch (err) {
      next(err);
    }
  });

export default router;