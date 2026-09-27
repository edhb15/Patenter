// Tests for shared/patent-tools.js (claim checks, numbering, deadlines).
// Run with: node --test tests/
const { test } = require("node:test");
const assert = require("node:assert/strict");

const T = require("../shared/patent-tools.js");

function blocks(lines) {
  return lines.map(line => {
    const heading = /^# /.test(line);
    return { text: heading ? line.slice(2) : line, tag: heading ? "h2" : "p" };
  });
}

const DOC = blocks([
  "# Description",
  "A widget is described.",
  "# Claims",
  "1. A widget comprising a housing and a first gear, wherein the first gear is arranged in the housing.",
  "2. The widget of claim 1, wherein the gear is red.",
  "3. The widget according to claim 1 or 2,",
  "wherein said housing is made of a plastic.",
  "# Abstract",
  "1. Not a claim."
]);

test("extracts claims below the claims heading", () => {
  const { headingFound, claims } = T.extractClaims(DOC);

  assert.equal(headingFound, true);
  assert.deepEqual(claims.map(c => c.number), [1, 2, 3]);
  assert.deepEqual(claims.map(c => c.dependsOn), [[], [1], [1, 2]]);
  assert.deepEqual(claims[2].blocks, [5, 6]);
  assert.match(claims[2].text, /said housing is made of a plastic\.$/);
});

test("finds claims without a heading and in numbered lists", () => {
  const plain = T.extractClaims(blocks(["Intro text.", "1. A lever.", "2. The lever of claim 1."]));
  assert.equal(plain.headingFound, false);
  assert.deepEqual(plain.claims.map(c => c.number), [1, 2]);

  const listed = T.extractClaims([
    { text: "Claims", tag: "h1" },
    { text: "A lever.", tag: "li", listNumber: 1 },
    { text: "The lever of claim 1.", tag: "li", listNumber: 2 }
  ]);
  assert.deepEqual(listed.claims.map(c => [c.number, c.dependsOn]), [[1, []], [2, [1]]]);
});

test("reads claim references including ranges", () => {
  assert.deepEqual(T.findReferencedClaims("according to any one of claims 1 to 3 or 5"), [1, 2, 3, 5]);
  assert.deepEqual(T.findReferencedClaims("as claimed in claim 2 and claim 4"), [2, 4]);
  assert.deepEqual(T.findReferencedClaims("claims 2-4"), [2, 3, 4]);
  assert.deepEqual(T.findReferencedClaims("A widget with no references."), []);
});

test("a clean claim set has no errors or warnings", () => {
  const { summary, issues } = T.checkClaims(T.extractClaims(DOC).claims);

  assert.deepEqual(summary, { total: 3, independent: 1, dependent: 2, multipleDependent: 1 });
  assert.deepEqual(issues.filter(i => i.severity !== "info"), []);
});

test("flags numbering, dependency and form problems", () => {
  const { claims } = T.extractClaims(blocks([
    "# Claims",
    "1. A device comprising a sensor. It is small",
    "3. The device of claim 1, wherein the controller reads the sensor.",
    "3. The device of claim 5, preferably blue.",
    "4. The device of claim 4."
  ]));

  const messages = T.checkClaims(claims).issues.map(i => `${i.severity}: ${i.message}`);
  const has = pattern => assert.ok(messages.some(m => pattern.test(m)), `${pattern} in\n${messages.join("\n")}`);

  has(/^error: Claim number 3 is used more than once/);
  has(/^error: Claims are not numbered consecutively: claim 3 follows claim 1/);
  has(/^error: Claim 3 refers to claim 5, which does not exist/);
  has(/^error: Claim 4 refers to itself/);
  has(/^warning: Claim 1 does not end with a full stop/);
  has(/^warning: Claim 1 seems to contain more than one sentence/);
  has(/^warning: Claim 3: "the controller" has no antecedent basis/);
  has(/^info: Claim 3 uses "preferably"/);
  assert.ok(!messages.some(m => /"the sensor"/.test(m)));
});

test("antecedent basis accepts common introductions", () => {
  const ok = [
    ["a first lever and a spring, the first lever pressing the spring", ""],
    ["a plurality of levers, each of the levers being movable", ""],
    ["one or more sensors, wherein the sensor is optical", ""],
    ["wherein the battery is charged", "A device comprising a battery."],
    ["the same material as the housing", "An assembly having a housing."]
  ];
  for (const [text, earlier] of ok) {
    assert.deepEqual(T.findAntecedentIssues(text, earlier), [], text);
  }

  assert.deepEqual(T.findAntecedentIssues("a lever and the spring", ""), [{ term: "the spring" }]);
  assert.deepEqual(T.findAntecedentIssues("said motor drives said motor", ""), [{ term: "said motor" }]);
});

test("claim fees", () => {
  const claims = Array.from({ length: 22 }, (_, i) => ({
    number: i + 1,
    text: "A thing.",
    dependsOn: [],
    independent: true
  }));
  const info = T.checkClaims(claims).issues.filter(i => i.severity === "info").map(i => i.message);

  assert.ok(info.some(m => /^EPO: 7 claim\(s\) above 15/.test(m)));
  assert.ok(info.some(m => /^USPTO: 2 claim\(s\) above 20/.test(m)));
  assert.ok(info.some(m => /^USPTO: 19 independent claim\(s\) above 3/.test(m)));
});

test("renumbers claims and their references", () => {
  const { claims } = T.extractClaims(blocks(["# Claims", "1. A.", "3. B of claim 1.", "4. C of claim 1 or 3.", "5. D of claims 3 to 4."]));
  const mapping = T.claimRenumbering(claims);

  assert.deepEqual([...mapping], [[1, 1], [3, 2], [4, 3], [5, 4]]);
  assert.equal(T.renumberReferences("C of claim 1 or 3.", mapping), "C of claim 1 or 2.");
  assert.equal(T.renumberReferences("D of claims 3 to 4.", mapping), "D of claims 2 to 3.");
  assert.equal(T.renumberReferences("Claim 3 and 7 parts", mapping), "Claim 2 and 7 parts");
  assert.equal(T.replaceLeadingClaimNumber("  3. B of claim 1.", 2), "  2. B of claim 1.");
  assert.equal(T.replaceLeadingClaimNumber("No number", 2), null);
});

test("picks description paragraphs for numbering", () => {
  const doc = [
    { text: "Widget", tag: "h1" },
    { text: "Technical field", tag: "p" },
    { text: "[0001] The invention relates to widgets.", tag: "p" },
    { text: "", tag: "p" },
    { text: "Widgets are known.", tag: "p" },
    { text: "continued text of the paragraph above.", tag: "p", continued: true },
    { text: "A list item.", tag: "ul" },
    { text: "Claims", tag: "h2" },
    { text: "1. A widget.", tag: "p" }
  ];

  assert.deepEqual(T.paragraphsToNumber(doc), [2, 4]);
  assert.equal(T.formatParagraphNumber(7), "[0007]");
  assert.equal(T.stripParagraphNumber("[0012] Text"), "Text");
});

test("month arithmetic follows the last-day rule", () => {
  const add = (date, months) => T.formatDate(T.addMonths(T.parseDate(date), months));

  assert.equal(add("2024-01-31", 1), "2024-02-29");
  assert.equal(add("2023-08-31", 18), "2025-02-28");
  assert.equal(add("2024-02-29", 12), "2025-02-28");
  assert.equal(add("2024-05-15", 30), "2026-11-15");
  assert.equal(T.parseDate("2024-02-30"), null);
  assert.equal(T.formatDate(T.nextWorkingDay(T.parseDate("2025-03-01"))), "2025-03-03");
  assert.equal(T.formatDate(T.nextWorkingDay(T.parseDate("2025-03-03"))), "2025-03-03");
});

test("PCT deadlines", () => {
  const { deadlines, errors } = T.computeDeadlines({
    route: "pct",
    priorityDate: "2024-05-15",
    filingDate: "2025-05-15",
    isrDate: "2025-09-10"
  });
  const byId = Object.fromEntries(deadlines.map(d => [d.id, d]));

  assert.deepEqual(errors, []);
  assert.equal(byId.priority, undefined);
  assert.equal(byId.publication.date, "2025-11-15");
  assert.equal(byId.publication.dueDate, "2025-11-17");
  assert.equal(byId.art19.date, "2025-11-10");
  assert.equal(byId.demand.date, "2026-03-15");
  assert.equal(byId.national30.date, "2026-11-15");
  assert.equal(byId.regional31.date, "2026-12-15");
  assert.equal(byId.term.date, "2045-05-15");
  assert.deepEqual(deadlines.map(d => d.date), deadlines.map(d => d.date).slice().sort());
});

test("first filing and EP deadlines", () => {
  const first = T.computeDeadlines({ route: "national", filingDate: "2025-06-02" });
  assert.equal(first.deadlines.find(d => d.id === "priority").date, "2026-06-02");

  const ep = T.computeDeadlines({ route: "ep", filingDate: "2024-02-29", searchReportDate: "2025-01-15" });
  const byId = Object.fromEntries(ep.deadlines.map(d => [d.id, d]));
  assert.equal(byId.examination.date, "2025-07-15");
  assert.equal(byId.renewal3.date, "2026-02-28");
  assert.equal(byId.renewal3.dueDate, "2026-03-02");
  assert.match(byId.renewal3.note, /until 2026-08-31/);
  assert.equal(byId.renewal20.date, "2043-02-28");
});

test("deadline input errors and warnings", () => {
  assert.deepEqual(T.computeDeadlines({ route: "ep", filingDate: "nope" }).errors, ["Enter a valid filing date."]);
  assert.match(T.computeDeadlines({ filingDate: "2025-01-01" }).errors[0], /type of application/);
  assert.match(
    T.computeDeadlines({ route: "ep", filingDate: "2024-01-01", priorityDate: "2024-06-01" }).errors[0],
    /cannot be after/
  );

  const late = T.computeDeadlines({ route: "ep", filingDate: "2025-03-01", priorityDate: "2024-01-01" });
  assert.equal(late.errors.length, 0);
  assert.match(late.warnings[0], /more than 12 months/);
});

test("exports deadlines as iCalendar", () => {
  const { deadlines } = T.computeDeadlines({ route: "national", filingDate: "2025-06-02" });
  const ics = T.deadlinesToICS(deadlines, "Widget; v2", new Date("2025-06-02T10:00:00Z"));

  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260602\r\nDTEND;VALUE=DATE:20260603/);
  assert.match(ics, /SUMMARY:Widget\\; v2: Priority year ends/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, deadlines.length);
});
