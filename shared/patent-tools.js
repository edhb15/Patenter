// Patent drafting helpers shared by the editor and the deadline page:
// claim parsing and checks, claim/paragraph numbering, and deadline
// calculation. Pure functions with no DOM access, so they also run under
// Node for tests (tests/patent-tools.test.js).

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PatentTools = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  // =========================================================
  // CLAIMS: FINDING THEM
  // =========================================================

  const CLAIMS_HEADING =
    /^(claims?|patent claims|what is claimed is|what is claimed|we claim|i claim|the invention claimed is|patentkrav|patentansprüche|revendications)\s*:?$/i;

  // Headings that end the claims section.
  const AFTER_CLAIMS_HEADING =
    /^(abstract|abstract of the disclosure|sammandrag|zusammenfassung|abrégé|list of reference (signs|numerals)|reference signs list)\s*:?$/i;

  const CLAIM_START = /^\s*(\d{1,3})\s*[.)]\s*(?=\S)/;

  // "claim 1", "claims 1 or 2", "any one of claims 1 to 3", "claims 1-4, 6"
  const CLAIM_REFERENCE =
    /\b(claims?)(\s+)(\d{1,3}(?:\s*(?:,|or|and|to|-|–)\s*(?:claims?\s+)?\d{1,3})*)/gi;

  function isHeadingBlock(block) {
    return /^h[1-6]$/i.test(block.tag || "");
  }

  function blockText(block) {
    return String(block.text || "").replace(/\s+/g, " ").trim();
  }

  // Index of the block that starts the claims section, or -1.
  function findClaimsHeading(blocks) {
    return blocks.findIndex(block => {
      const text = blockText(block);
      return text.length <= 60 && CLAIMS_HEADING.test(text);
    });
  }

  // Parses the claims out of a document given as blocks
  // ({ text, tag, listNumber }). Paragraphs without a leading number
  // are continuation lines of the claim above them.
  function extractClaims(blocks) {

    const heading = findClaimsHeading(blocks);
    const start = heading >= 0 ? heading + 1 : 0;

    const claims = [];

    for (let i = start; i < blocks.length; i++) {

      const block = blocks[i];
      const text = blockText(block);

      if (!text) continue;

      if (heading >= 0 && isHeadingBlock(block) && !CLAIM_START.test(text)) break;
      if (AFTER_CLAIMS_HEADING.test(text)) break;

      const match = CLAIM_START.exec(text);

      if (block.listNumber) {
        claims.push({ number: block.listNumber, text, blocks: [i], listNumbered: true });
      } else if (match) {
        claims.push({ number: Number(match[1]), text: text.slice(match[0].length), blocks: [i] });
      } else if (heading >= 0 && claims.length > 0) {
        const last = claims[claims.length - 1];
        last.text += " " + text;
        last.blocks.push(i);
      }
    }

    for (const claim of claims) {
      claim.dependsOn = findReferencedClaims(claim.text);
      claim.independent = claim.dependsOn.length === 0;
    }

    return { headingFound: heading >= 0, headingIndex: heading, claims };
  }

  // Claim numbers referred to in a text, in order, without duplicates.
  function findReferencedClaims(text) {

    const numbers = [];

    for (const match of String(text).matchAll(CLAIM_REFERENCE)) {

      const tokens = match[3].match(/\d+|to|-|–/g);

      for (let i = 0; i < tokens.length; i++) {
        if (/^\d+$/.test(tokens[i])) {
          const n = Number(tokens[i]);
          // "1 to 4" / "1-4" is a range.
          if (/^(to|-|–)$/.test(tokens[i + 1] || "") && /^\d+$/.test(tokens[i + 2] || "")) {
            const end = Number(tokens[i + 2]);
            for (let k = n; k <= end && k - n < 200; k++) numbers.push(k);
            i += 2;
          } else {
            numbers.push(n);
          }
        }
      }
    }

    return [...new Set(numbers)];
  }

  // =========================================================
  // CLAIMS: CHECKING THEM
  // =========================================================

  // Words after "the"/"said" that never need an earlier "a"/"an".
  const NO_ANTECEDENT_NEEDED = new Set([
    "same", "invention", "claim", "claims", "following", "above", "like", "other",
    "respective", "art", "case", "extent", "use", "form", "way", "manner", "time",
    "basis", "purpose", "presence", "absence", "range", "group", "order", "end",
    "fact", "result", "effect", "one"
  ]);

  // Words that end a noun phrase after "the"/"said".
  const PHRASE_STOP = new Set([
    "of", "and", "or", "to", "is", "are", "be", "being", "been", "was", "were",
    "wherein", "whereby", "which", "that", "with", "within", "without", "in", "on",
    "for", "by", "from", "at", "into", "onto", "as", "when", "where", "while", "has",
    "have", "having", "comprises", "comprising", "includes", "including", "consists",
    "consisting", "according", "so", "such", "than", "further", "via", "through",
    "between", "along", "about", "around", "under", "over", "above", "below", "can",
    "may", "will", "shall", "not", "each", "if", "then", "therein", "thereof",
    "the", "said", "a", "an"
  ]);

  // Modifiers that don't identify a feature on their own: "the first gear"
  // needs "a first gear", not just any "a first ...".
  const MODIFIERS = new Set([
    "first", "second", "third", "fourth", "further", "other", "upper", "lower",
    "inner", "outer", "left", "right", "front", "rear", "top", "bottom", "main"
  ]);

  const INTRODUCERS =
    "a|an|one|two|three|several|multiple|plural|plurality of|number of|set of|pair of|" +
    "at least one|at least two|one or more|two or more|first|second|third|further|another|" +
    "some|any|each|every|comprising|comprises|including|includes|having|has";

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Singular/plural forms tried when looking for an earlier mention.
  function wordForms(word) {
    const forms = new Set([word]);
    if (/ies$/.test(word)) forms.add(word.slice(0, -3) + "y");
    if (/(s|x|z|ch|sh)es$/.test(word)) forms.add(word.slice(0, -2));
    if (/s$/.test(word) && !/ss$/.test(word)) forms.add(word.slice(0, -1));
    if (/y$/.test(word) && !/[aeiou]y$/.test(word)) forms.add(word.slice(0, -1) + "ies");
    forms.add(/(s|x|z|ch|sh)$/.test(word) ? word + "es" : word + "s");
    return [...forms];
  }

  // "the/said X" terms with no earlier introduction in the claim or the
  // claims it depends on. Returns [{ term }], each term once.
  function findAntecedentIssues(claimText, earlierText) {

    const issues = [];
    const reported = new Set();

    const regex = /\b(the|said)\s+([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,2})/gi;

    for (const match of claimText.matchAll(regex)) {

      const words = [];

      for (const word of match[2].toLowerCase().split(/\s+/)) {
        if (PHRASE_STOP.has(word)) break;
        words.push(word);
      }

      if (words.length === 0 || NO_ANTECEDENT_NEEDED.has(words[0])) continue;

      const phrase = words.join(" ");

      if (reported.has(phrase)) continue;

      const before = earlierText + " " + claimText.slice(0, match.index);

      // The noun phrase ends somewhere in these words ("the controller
      // reads ..."), so each prefix is tried, shortest first. "a first
      // lever" introduces "the lever" and "the first lever"; "a plurality
      // of levers" introduces "the levers" and "the lever".
      const candidates = words
        .map((_, n) => words.slice(0, n + 1))
        .filter(prefix => !(prefix.length === 1 && MODIFIERS.has(prefix[0]) && words.length > 1));

      const isIntroduced = prefix => {
        const head = prefix[prefix.length - 1];
        const lead = prefix.slice(0, -1).map(escapeRegExp).join("\\s+");
        return wordForms(head).some(form => {
          const noun = (lead ? lead + "\\s+" : "") + escapeRegExp(form);
          return new RegExp(
            `\\b(?:${INTRODUCERS})\\s+(?:(?!the\\b|said\\b)[\\w-]+\\s+){0,4}?${noun}\\b`,
            "i"
          ).test(before);
        });
      };

      const introduced = candidates.some(isIntroduced);

      if (!introduced) {
        const shortest = (candidates[0] || words).join(" ");
        if (!reported.has(shortest)) {
          issues.push({ term: `${match[1].toLowerCase()} ${shortest}` });
        }
        reported.add(phrase);
        reported.add(shortest);
      }
    }

    return issues;
  }

  // Everything a claim can rely on for antecedent basis: the claims it
  // refers to, and theirs, recursively.
  function ancestorText(claim, byNumber, seen = new Set()) {

    let text = "";

    for (const n of claim.dependsOn) {
      const parent = byNumber.get(n);
      if (!parent || seen.has(n)) continue;
      seen.add(n);
      text += " " + ancestorText(parent, byNumber, seen) + " " + parent.text;
    }

    return text;
  }

  // One sentence per claim: a full stop in the middle usually means two.
  function hasInnerSentenceBreak(text) {
    const stripped = text
      .replace(/\b(e\.g|i\.e|etc|approx|ca|cf|fig|figs|no|nos|resp|vs|incl|max|min|ref)\./gi, "$1")
      .replace(/\d\.\d/g, "0");
    return /\.\s+[A-Z]/.test(stripped.replace(/\.\s*$/, ""));
  }

  function countSummary(claims) {
    const independent = claims.filter(c => c.independent).length;
    return {
      total: claims.length,
      independent,
      dependent: claims.length - independent,
      multipleDependent: claims.filter(c => c.dependsOn.length > 1).length
    };
  }

  // Checks a parsed claim set. Issues: { claim, severity, message } with
  // severity "error" | "warning" | "info"; claim is null for set-wide notes.
  function checkClaims(claims) {

    const issues = [];
    const byNumber = new Map();

    // Numbering
    claims.forEach((claim, index) => {
      if (byNumber.has(claim.number)) {
        issues.push({ claim: claim.number, index, severity: "error", message: `Claim number ${claim.number} is used more than once.` });
      } else {
        byNumber.set(claim.number, claim);
      }
    });

    const outOfOrder = claims.findIndex((claim, index) => claim.number !== index + 1);

    if (outOfOrder >= 0) {
      const claim = claims[outOfOrder];
      issues.push({
        claim: claim.number, index: outOfOrder, severity: "error",
        message: outOfOrder === 0
          ? `Claims should start at 1, not ${claim.number}. Use "Renumber claims" to fix numbering.`
          : `Claims are not numbered consecutively: claim ${claim.number} follows claim ${claims[outOfOrder - 1].number}. Use "Renumber claims" to fix numbering.`
      });
    }

    claims.forEach((claim, index) => {

      // Dependencies
      for (const n of claim.dependsOn) {
        if (n === claim.number) {
          issues.push({ claim: claim.number, index, severity: "error", message: `Claim ${claim.number} refers to itself.` });
        } else if (!byNumber.has(n)) {
          issues.push({ claim: claim.number, index, severity: "error", message: `Claim ${claim.number} refers to claim ${n}, which does not exist.` });
        } else if (n > claim.number) {
          issues.push({ claim: claim.number, index, severity: "error", message: `Claim ${claim.number} refers to a later claim (${n}); a claim may only refer to claims before it.` });
        }
      }

      if (claim.dependsOn.length > 1) {
        const onMultiple = claim.dependsOn.filter(n => (byNumber.get(n)?.dependsOn.length || 0) > 1);
        if (onMultiple.length) {
          issues.push({ claim: claim.number, index, severity: "warning", message: `Claim ${claim.number} is a multiple dependent claim that refers to another multiple dependent claim (${onMultiple.join(", ")}). Not allowed in the US (35 U.S.C. 112(e)) and several other countries.` });
        }
      }

      // Form
      if (!/[.]\s*$/.test(claim.text)) {
        issues.push({ claim: claim.number, index, severity: "warning", message: `Claim ${claim.number} does not end with a full stop.` });
      }

      if (hasInnerSentenceBreak(claim.text)) {
        issues.push({ claim: claim.number, index, severity: "warning", message: `Claim ${claim.number} seems to contain more than one sentence; a claim should be a single sentence.` });
      }

      if (/\b(preferably|for example|e\.g\.|such as|in particular|optionally|approximately|substantially|about)\b/i.test(claim.text)) {
        const term = /\b(preferably|for example|e\.g\.|such as|in particular|optionally|approximately|substantially|about)\b/i.exec(claim.text)[1];
        issues.push({ claim: claim.number, index, severity: "info", message: `Claim ${claim.number} uses "${term}", which can make its scope unclear.` });
      }

      // Antecedent basis
      const earlier = ancestorText(claim, byNumber);
      for (const { term } of findAntecedentIssues(claim.text, earlier)) {
        issues.push({ claim: claim.number, index, severity: "warning", message: `Claim ${claim.number}: "${term}" has no antecedent basis (no earlier "a/an …").` });
      }
    });

    // Fees
    const summary = countSummary(claims);

    if (summary.total > 15) {
      const higher = Math.max(0, summary.total - 50);
      issues.push({
        claim: null, severity: "info",
        message: `EPO: ${summary.total - 15} claim(s) above 15 incur claims fees` +
          (higher ? `, ${higher} of them at the higher rate (above 50).` : ".")
      });
    }

    if (summary.total > 20) {
      issues.push({ claim: null, severity: "info", message: `USPTO: ${summary.total - 20} claim(s) above 20 incur excess claims fees.` });
    }

    if (summary.independent > 3) {
      issues.push({ claim: null, severity: "info", message: `USPTO: ${summary.independent - 3} independent claim(s) above 3 incur excess claims fees.` });
    }

    if (summary.multipleDependent > 0) {
      issues.push({ claim: null, severity: "info", message: `USPTO: multiple dependent claims (${summary.multipleDependent}) incur an extra fee.` });
    }

    return { summary, issues };
  }

  // =========================================================
  // NUMBERING
  // =========================================================

  // New numbers for claims in their current order: Map(old -> new).
  // With duplicate numbers, references point at the first claim.
  function claimRenumbering(claims) {
    const mapping = new Map();
    claims.forEach((claim, index) => {
      if (!mapping.has(claim.number)) mapping.set(claim.number, index + 1);
    });
    return mapping;
  }

  // Rewrites claim references ("claim 3", "claims 2 to 4") in a text.
  function renumberReferences(text, mapping) {
    return String(text).replace(CLAIM_REFERENCE, (all, word, space, list) =>
      word + space + list.replace(/\d+/g, n => String(mapping.get(Number(n)) ?? n))
    );
  }

  // Rewrites the leading "3." of a claim; returns null if there is none.
  function replaceLeadingClaimNumber(text, newNumber) {
    const match = /^(\s*)(\d{1,3})(\s*[.)])/.exec(text);
    if (!match) return null;
    return match[1] + newNumber + text.slice(match[1].length + match[2].length);
  }

  const PARAGRAPH_NUMBER = /^\s*\[\d{4,5}\]\s*/;

  function formatParagraphNumber(n) {
    return `[${String(n).padStart(4, "0")}]`;
  }

  function stripParagraphNumber(text) {
    return String(text).replace(PARAGRAPH_NUMBER, "");
  }

  // Short lines without closing punctuation are headings typed as normal
  // text ("Background of the invention") and don't get a number.
  function looksLikeHeading(text) {
    const clean = stripParagraphNumber(text).trim();
    return clean.length <= 80 &&
      clean.split(/\s+/).length <= 10 &&
      !/[.:;!?]$/.test(clean);
  }

  // Indexes of the description blocks that get paragraph numbers: text
  // paragraphs before the claims/abstract, skipping headings, empty lines
  // and the second half of paragraphs split across pages.
  function paragraphsToNumber(blocks) {

    const indexes = [];

    for (let i = 0; i < blocks.length; i++) {

      const block = blocks[i];
      const text = blockText(block);

      if (CLAIMS_HEADING.test(text) || AFTER_CLAIMS_HEADING.test(text)) break;

      if (
        !text ||
        isHeadingBlock(block) ||
        !/^(p|div|blockquote)$/i.test(block.tag || "p") ||
        block.continued ||
        looksLikeHeading(text)
      ) {
        continue;
      }

      indexes.push(i);
    }

    return indexes;
  }

  // =========================================================
  // DEADLINES
  // =========================================================
  // Dates are "YYYY-MM-DD" strings handled in UTC so time zones and
  // daylight saving never shift a day.

  function parseDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    return date.getUTCMonth() === +match[2] - 1 ? date : null;
  }

  function formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function lastDayOfMonth(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  function isLastDayOfMonth(date) {
    return date.getUTCDate() === lastDayOfMonth(date.getUTCFullYear(), date.getUTCMonth());
  }

  // Month periods (EPC Rule 131(4), PCT Rule 80.5): same day number, or
  // the last day of the month if that day doesn't exist.
  function addMonths(date, months) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    const target = new Date(Date.UTC(year, month, 1));
    const day = Math.min(date.getUTCDate(), lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth()));
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
  }

  function endOfMonth(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  }

  // A period ending on a Saturday or Sunday runs to the next Monday
  // (e.g. EPC Rule 134(1)). Public holidays are not known here.
  function nextWorkingDay(date) {
    const day = date.getUTCDay();
    const shift = day === 6 ? 2 : day === 0 ? 1 : 0;
    return new Date(date.getTime() + shift * 86400000);
  }

  const ROUTES = ["national", "ep", "pct"];

  // Deadlines for an application. Input:
  //   route: "national" (first filing) | "ep" (European application) | "pct"
  //   filingDate (required), priorityDate (earliest; defaults to filing date),
  //   searchReportDate (EP: publication of the European search report),
  //   isrDate (PCT: transmittal of the international search report)
  // Returns { deadlines (sorted by date), errors, warnings }.
  function computeDeadlines(input) {

    const errors = [];
    const warnings = [];
    const route = ROUTES.includes(input.route) ? input.route : null;
    const filing = parseDate(input.filingDate);
    const priority = input.priorityDate ? parseDate(input.priorityDate) : filing;
    const searchReport = input.searchReportDate ? parseDate(input.searchReportDate) : null;
    const isr = input.isrDate ? parseDate(input.isrDate) : null;

    if (!route) errors.push("Choose the type of application.");
    if (!filing) errors.push("Enter a valid filing date.");
    if (input.priorityDate && !priority) errors.push("Enter a valid priority date.");
    if (input.searchReportDate && !searchReport) errors.push("Enter a valid search report date.");
    if (input.isrDate && !isr) errors.push("Enter a valid search report transmittal date.");
    if (filing && priority && priority > filing) errors.push("The priority date cannot be after the filing date.");

    if (errors.length) {
      return { deadlines: [], errors, warnings };
    }

    if (addMonths(priority, 12) < filing) {
      warnings.push("The filing date is more than 12 months after the priority date, so the priority claim is invalid unless priority is restored (possible within 2 further months).");
    }

    const deadlines = [];

    function add(id, label, date, rule, note, group = "main") {
      const due = nextWorkingDay(date);
      deadlines.push({
        id, label, group, rule, note: note || "",
        date: formatDate(date),
        dueDate: formatDate(due),
        shifted: due.getTime() !== date.getTime()
      });
    }

    const firstFiling = priority.getTime() === filing.getTime();

    if (firstFiling) {
      add("priority", "Priority year ends: last day to file abroad (PCT, EP, national) claiming priority",
        addMonths(priority, 12), "Paris Convention Art. 4C; PCT Art. 8",
        "Later filings lose the priority right. Restoration may be possible up to 2 months after this date if the delay was unintentional/despite due care.");
    }

    add("publication", "Publication of the application (about)",
      addMonths(priority, 18), "EPC Art. 93; PCT Art. 21(2)",
      "Withdraw before technical preparations for publication are complete (about 5 weeks before) to keep the application unpublished.");

    if (route === "pct") {

      if (isr) {
        const art19 = [addMonths(isr, 2), addMonths(priority, 16)].sort((a, b) => b - a)[0];
        add("art19", "Amend claims under Article 19 (optional)", art19, "PCT Rule 46.1",
          "Later of 2 months from transmittal of the search report or 16 months from priority.");
      }

      const demandBase = addMonths(priority, 22);
      const demand = isr && addMonths(isr, 3) > demandBase ? addMonths(isr, 3) : demandBase;
      add("demand", "File demand for international preliminary examination (Chapter II, optional)", demand,
        "PCT Rule 54bis.1",
        isr ? "Later of 3 months from transmittal of the search report or 22 months from priority."
            : "Or 3 months from transmittal of the search report, if later. Enter that date for an exact result.");

      add("national30", "Enter the national phase (US, CN, JP and most other countries)", addMonths(priority, 30),
        "PCT Art. 22/39", "Some offices allow 31 months or more (e.g. KR, AU). Check each country.");

      add("regional31", "Enter the European regional phase (EPO)", addMonths(priority, 31),
        "EPC Rule 159(1)", "Filing fee, search fee, designation fee, examination request and, if due, the 3rd-year renewal fee.");
    }

    if (route === "ep") {

      if (searchReport) {
        add("examination", "Request examination and pay the examination and designation fees",
          addMonths(searchReport, 6), "EPC Rule 70(1), Rule 39(1)",
          "6 months from the date the European Patent Bulletin mentions publication of the search report. Reply to the search opinion by the same date.");
      }

      for (let year = 3; year <= 20; year++) {
        const due = endOfMonth(addMonths(filing, (year - 1) * 12));
        const grace = addMonths(due, 6);
        add(`renewal${year}`, `Renewal fee for year ${year}`, due, "EPC Art. 86, Rule 51(1)",
          `May still be paid with a 50% surcharge until ${formatDate(isLastDayOfMonth(due) ? endOfMonth(grace) : grace)}.`,
          "renewal");
      }
    }

    add("term", "Maximum patent term ends (20 years from filing)",
      addMonths(filing, 240), "EPC Art. 63(1); TRIPS Art. 33",
      "Some countries extend the term, e.g. SPCs for medicines and US patent term adjustment.", "term");

    deadlines.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    return { deadlines, errors, warnings };
  }

  function daysBetween(from, to) {
    return Math.round((parseDate(to) - parseDate(from)) / 86400000);
  }

  // iCalendar file with one all-day event per deadline.
  function deadlinesToICS(deadlines, title, now = new Date()) {

    const escape = text => String(text).replace(/[\\;,]/g, m => "\\" + m).replace(/\r?\n/g, "\\n");
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const compact = iso => iso.replace(/-/g, "");

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Patenter//Deadlines//EN",
      "CALSCALE:GREGORIAN"
    ];

    for (const d of deadlines) {
      const next = new Date(parseDate(d.dueDate).getTime() + 86400000);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${d.id}-${compact(d.dueDate)}-${Math.random().toString(36).slice(2)}@patenter`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${compact(d.dueDate)}`,
        `DTEND;VALUE=DATE:${compact(formatDate(next))}`,
        `SUMMARY:${escape((title ? title + ": " : "") + d.label)}`,
        `DESCRIPTION:${escape([d.rule, d.note].filter(Boolean).join(" — "))}`,
        "END:VEVENT"
      );
    }

    lines.push("END:VCALENDAR");

    return lines.join("\r\n") + "\r\n";
  }

  return {
    extractClaims,
    findReferencedClaims,
    findAntecedentIssues,
    checkClaims,
    claimRenumbering,
    renumberReferences,
    replaceLeadingClaimNumber,
    formatParagraphNumber,
    stripParagraphNumber,
    paragraphsToNumber,
    PARAGRAPH_NUMBER,
    parseDate,
    formatDate,
    addMonths,
    nextWorkingDay,
    computeDeadlines,
    daysBetween,
    deadlinesToICS
  };
});
