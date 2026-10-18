import { AppError } from "../errors/AppError";
import { creditRepository, CreditState } from "../credits/CreditRepository";
import { PLANS, planToApi } from "../credits/plans";

const DAY_MS = 24 * 60 * 60 * 1000;

// The UTC date, e.g. "2026-10-18". Credits refill when it changes.
export function utcDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function usedOn(state: CreditState, day: string) {
  return state.creditsDay && utcDay(state.creditsDay) === day ? state.creditsUsed : 0;
}

// What the browser and the backend see. `used` can exceed the allowance
// for the rest of the day after a downgrade; `remaining` never goes below 0.
function toCredits(state: CreditState, day: string) {
  const dailyAllowance = PLANS[state.plan].dailyCredits;
  const used = usedOn(state, day);

  return {
    dailyAllowance,
    used,
    remaining: Math.max(dailyAllowance - used, 0),
    resetsAt: new Date(Date.parse(day) + DAY_MS).toISOString(),
  };
}

function notFound() {
  return new AppError("User not found", 404);
}

export const creditService = {
  async getAccount(userId: string, now = new Date()) {
    const state = await creditRepository.find(userId);

    if (!state) {
      throw notFound();
    }

    return {
      plan: planToApi(state.plan),
      credits: toCredits(state, utcDay(now)),
    };
  },

  // Spends `amount` credits. When there aren't enough, nothing is spent
  // and `ok` is false, unless `partial` is set: then whatever is left
  // is spent instead (used for AI replies, which are priced after the
  // answer has been written).
  async spend(userId: string, amount: number, partial: boolean, now = new Date()) {
    const day = utcDay(now);

    const outcome = await creditRepository.update(userId, (state) => {
      const remaining = toCredits(state, day).remaining;
      const spent = partial ? Math.min(amount, remaining) : amount;

      if (spent > remaining) {
        return { save: null, result: { ok: false, spent: 0, credits: toCredits(state, day) } };
      }

      const after = {
        ...state,
        creditsUsed: usedOn(state, day) + spent,
        creditsDay: new Date(day),
      };

      return {
        save: { creditsUsed: after.creditsUsed, creditsDay: after.creditsDay },
        result: { ok: true, spent, credits: toCredits(after, day) },
      };
    });

    if (!outcome) {
      throw notFound();
    }

    return { ...outcome, day };
  },

  // Gives back credits spent on `day` for an action that then failed.
  // Usage from an earlier day has already been reset, so those are not
  // returned (that would top up today's allowance).
  async refund(userId: string, amount: number, day: string, now = new Date()) {
    const today = utcDay(now);

    const credits = await creditRepository.update(userId, (state) => {
      if (day !== today) {
        return { save: null, result: toCredits(state, today) };
      }

      const after = {
        ...state,
        creditsUsed: Math.max(usedOn(state, today) - amount, 0),
        creditsDay: new Date(today),
      };

      return {
        save: { creditsUsed: after.creditsUsed, creditsDay: after.creditsDay },
        result: toCredits(after, today),
      };
    });

    if (!credits) {
      throw notFound();
    }

    return credits;
  },
};
