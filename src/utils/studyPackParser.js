/**
 * Parses generated Markdown study packs into structured flashcards
 * from "# Key Definitions" and "# Revision Questions" sections.
 */

function stripMarkdownWrapper(text) {
  let out = text.trim();
  out = out.replace(/^\*\*(.+?)\*\*$/, "$1").replace(/^\*(.+?)\*$/, "$1");
  out = out.replace(/^__(.+?)__$/, "$1").replace(/^_(.+?)_$/, "$1");
  return out.trim();
}

function cleanCardText(text) {
  return text.replace(/  \n/g, "\n").trim();
}

function splitDefinitions(lines) {
  const cards = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "---") continue;

    // Matches: "- **Term** *(note)*: Definition" or "- Term: Definition"
    const defMatch = line.match(
      /^(?:[-*•]|\d+\.)\s+\*\*([^*]+)\*\*(?:\s*\([^)]*\))?\s*[:\-–—]\s*(.+)$/
    );
    const plainMatch =
      !defMatch && line.match(/^(?:[-*•]|\d+\.)\s+([^:]{2,80}):\s+(.+)$/);

    if (defMatch) {
      if (current) cards.push(current);
      const noteMatch = line.match(/\*\(([^)]+)\)\*/);
      const front = noteMatch
        ? `${defMatch[1].trim()} (${noteMatch[1].trim()})`
        : defMatch[1].trim();
      current = {
        type: "definition",
        front,
        back: cleanCardText(defMatch[2]),
      };
    } else if (plainMatch) {
      if (current) cards.push(current);
      current = {
        type: "definition",
        front: stripMarkdownWrapper(plainMatch[1]),
        back: cleanCardText(plainMatch[2]),
      };
    } else if (current) {
      current.back = `${current.back}\n${line}`;
    }
  }

  if (current) cards.push(current);
  return cards;
}

function splitQuestionBlocks(lines) {
  const blocks = [];
  let currentBlock = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === "---") continue;

    const numMatch = rawLine.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numMatch) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = [numMatch[1]];
    } else if (currentBlock) {
      currentBlock.push(rawLine);
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  const cards = [];
  for (const block of blocks) {
    const firstLine = block[0].trim();
    const restLines = block
      .slice(1)
      .map((l) => l.replace(/^\s{2,4}/, "").trimEnd())
      .filter((l, idx, arr) => l.trim() !== "" || (idx > 0 && idx < arr.length - 1));

    let front = "";
    let back = "";

    // Case 1: Question and inline answer on same line: "**Question?** Answer" or "**Q?** — Answer"
    const inlineBold = firstLine.match(/^\*\*([^*]+)\*\*\s*(?:[:\-–—]\s*)?(.+)$/);
    if (inlineBold && inlineBold[2].trim()) {
      front = inlineBold[1].trim();
      const tail = restLines.join("\n").trim();
      back = tail ? `${inlineBold[2].trim()}\n${tail}` : inlineBold[2].trim();
    } else if (restLines.length > 0) {
      // Case 2: Question on line 1, answer on subsequent lines (often starting with *Answer:* or *...*)
      front = stripMarkdownWrapper(firstLine);
      let joinedBack = restLines.join("\n").trim();
      joinedBack = joinedBack.replace(/^\*{1,2}Answer\s*:?\*{1,2}\s*/i, "").trim();
      // Unwrap whole-block outer italics (*...*) while preserving nested markdown bullets
      if (
        joinedBack.startsWith("*") &&
        joinedBack.endsWith("*") &&
        !joinedBack.startsWith("**") &&
        joinedBack.indexOf("\n") === -1
      ) {
        joinedBack = joinedBack.slice(1, -1).trim();
      }
      back = joinedBack;
    } else {
      // Single-line fallback split on '?'
      const qSplit = firstLine.match(/^(.+?\?)\s+(.+)$/);
      if (qSplit) {
        front = stripMarkdownWrapper(qSplit[1]);
        back = stripMarkdownWrapper(qSplit[2]);
      }
    }

    if (front && back) {
      cards.push({
        type: "question",
        front: cleanCardText(front),
        back: cleanCardText(back),
      });
    }
  }
  return cards;
}

export function parseStudyPackCards(markdown, deckId = "session") {
  if (!markdown || typeof markdown !== "string") return [];

  const lines = markdown.split(/\r?\n/);
  let currentSection = "";
  const definitionLines = [];
  const questionLines = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (headingMatch) {
      const heading = headingMatch[1].toLowerCase();
      if (heading.includes("definition") || heading.includes("key term")) {
        currentSection = "definitions";
      } else if (
        heading.includes("revision question") ||
        heading.includes("important question") ||
        heading.includes("practice question")
      ) {
        currentSection = "questions";
      } else {
        currentSection = "other";
      }
      continue;
    }

    if (currentSection === "definitions") {
      definitionLines.push(line);
    } else if (currentSection === "questions") {
      questionLines.push(line);
    }
  }

  const parsedDefs = splitDefinitions(definitionLines);
  const parsedQuestions = splitQuestionBlocks(questionLines);
  const combined = [...parsedDefs, ...parsedQuestions];

  return combined.map((card, index) => ({
    ...card,
    id: `${deckId}::${index}`,
  }));
}

export function buildCsvFromCards(cards) {
  const escapeCell = (val) => `"${String(val || "").replace(/"/g, '""')}"`;
  const rows = [["Front", "Back", "Type"].map(escapeCell).join(",")];
  for (const card of cards) {
    rows.push(
      [card.front, card.back, card.type || "flashcard"].map(escapeCell).join(",")
    );
  }
  return rows.join("\n");
}

export function formatStudyDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
