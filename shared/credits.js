// Shows how many credits the signed-in user has left today in every
// element marked data-credits (usually a link to the plan page). Needs
// shared/auth-client.js.
//
// Paid API calls (chat, editor actions, search, compare) answer with the
// new balance; pages pass it to PatenterCredits.show() so the label stays
// current without asking the server again.
(function () {
  "use strict";

  function show(credits) {
    if (!credits || typeof credits.remaining !== "number") return;

    const label = credits.remaining === 1 ? "1 credit left" : `${credits.remaining} credits left`;
    const hint = `${credits.remaining} of ${credits.dailyAllowance} credits left today. ` +
      "Credits refill every day at 00:00 UTC.";

    document.querySelectorAll("[data-credits]").forEach(el => {
      el.textContent = label;
      el.title = hint;
      el.classList.toggle("credits-empty", credits.remaining === 0);
      el.hidden = false;
    });
  }

  // Loads the balance from the server; resolves to the account or null.
  async function refresh() {
    const account = await PatenterAuth.getAccount();
    if (account) show(account.credits);
    return account;
  }

  window.PatenterCredits = { show, refresh };
})();
