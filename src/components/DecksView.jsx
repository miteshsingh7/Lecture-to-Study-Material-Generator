import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { buildCsvFromCards, parseStudyPackCards } from "../utils/studyPackParser";

const MASTERY_STORAGE_KEY = "lecture_study_deck_mastery_v1";
const CUSTOM_CARDS_STORAGE_KEY = "lecture_study_custom_cards_v1";

function loadJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export default function DecksView({
  libraryItems,
  selectedDeckJobId,
  deckPack,
  loadingDeck,
  deckError,
  onSelectDeck,
  onRetryDeck,
  onGoToLibrary,
  onGoToGenerator,
}) {
  const [filterMode, setFilterMode] = useState("all"); // all | definition | question | review
  const [cardIndex, setCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState(null);
  const [showList, setShowList] = useState(false);
  const [addingCustom, setAddingCustom] = useState(false);
  const [customFront, setCustomFront] = useState("");
  const [customBack, setCustomBack] = useState("");

  const [masteryMap, setMasteryMap] = useState(() =>
    loadJsonStorage(MASTERY_STORAGE_KEY, {})
  );
  const [customCardsByDeck, setCustomCardsByDeck] = useState(() =>
    loadJsonStorage(CUSTOM_CARDS_STORAGE_KEY, {})
  );

  const deckId = deckPack?.jobId || selectedDeckJobId || "";

  const baseCards = useMemo(() => {
    if (!deckPack?.content) return [];
    return parseStudyPackCards(deckPack.content, deckId);
  }, [deckPack?.content, deckId]);

  const allCards = useMemo(() => {
    const custom = customCardsByDeck[deckId] || [];
    return [...baseCards, ...custom];
  }, [baseCards, customCardsByDeck, deckId]);

  const counts = useMemo(() => {
    let definitions = 0;
    let questions = 0;
    let review = 0;
    let mastered = 0;
    for (const c of allCards) {
      if (c.type === "definition") definitions += 1;
      if (c.type === "question") questions += 1;
      const status = masteryMap[c.id];
      if (status === "mastered") mastered += 1;
      if (!status || status === "review") review += 1;
    }
    return {
      total: allCards.length,
      definitions,
      questions,
      review,
      mastered,
    };
  }, [allCards, masteryMap]);

  const filteredCards = useMemo(() => {
    let list = allCards;
    if (filterMode === "definition") {
      list = allCards.filter((c) => c.type === "definition");
    } else if (filterMode === "question") {
      list = allCards.filter((c) => c.type === "question");
    } else if (filterMode === "review") {
      list = allCards.filter((c) => masteryMap[c.id] !== "mastered");
    }

    if (shuffleOrder && shuffleOrder.length === list.length) {
      return shuffleOrder.map((idx) => list[idx]).filter(Boolean);
    }
    return list;
  }, [allCards, filterMode, masteryMap, shuffleOrder]);

  useEffect(() => {
    setCardIndex(0);
    setIsFlipped(false);
    setShuffleOrder(null);
  }, [deckId, filterMode]);

  const safeIndex =
    filteredCards.length > 0 ? Math.min(cardIndex, filteredCards.length - 1) : 0;
  const currentCard = filteredCards[safeIndex] || null;

  useEffect(() => {
    const onKeyDown = (e) => {
      if (
        e.defaultPrevented ||
        e.target.closest("button, [role='button'], a, input, select, textarea")
      ) {
        return;
      }
      if (!currentCard) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setIsFlipped((prev) => !prev);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIsFlipped(false);
        setCardIndex((prev) => (prev + 1) % filteredCards.length);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIsFlipped(false);
        setCardIndex((prev) =>
          prev - 1 < 0 ? filteredCards.length - 1 : prev - 1
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentCard, filteredCards.length]);

  const setCardMastery = (cardId, level) => {
    const next = { ...masteryMap, [cardId]: level };
    setMasteryMap(next);
    try {
      localStorage.setItem(MASTERY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
    if (filteredCards.length > 1) {
      setIsFlipped(false);
      setCardIndex((prev) => (prev + 1) % filteredCards.length);
    }
  };

  const handleShuffle = () => {
    if (filteredCards.length < 2) return;
    const indices = filteredCards.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    setShuffleOrder(indices);
    setCardIndex(0);
    setIsFlipped(false);
  };

  const handleExportCsv = () => {
    if (allCards.length === 0) return;
    const csv = buildCsvFromCards(allCards);
    const base = (deckPack?.title || deckPack?.filename || "lecture_deck")
      .replace(/\.(txt|pdf)$/i, "")
      .trim();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${base || "lecture"}_flashcards.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleAddCustomCard = (e) => {
    e.preventDefault();
    if (!customFront.trim() || !customBack.trim() || !deckId) return;
    const existing = customCardsByDeck[deckId] || [];
    const newCard = {
      id: `${deckId}::custom::${Date.now()}`,
      type: "custom",
      front: customFront.trim(),
      back: customBack.trim(),
    };
    const next = { ...customCardsByDeck, [deckId]: [...existing, newCard] };
    setCustomCardsByDeck(next);
    try {
      localStorage.setItem(CUSTOM_CARDS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
    setCustomFront("");
    setCustomBack("");
    setAddingCustom(false);
  };

  const masteryPct =
    counts.total > 0 ? Math.round((counts.mastered / counts.total) * 100) : 0;

  return (
    <div className="w-full max-w-4xl mx-auto py-space-lg md:py-space-xl flex flex-col gap-space-lg">
      {/* Header + Deck Selector */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
        <div>
          <div className="inline-flex items-center gap-space-xs px-2.5 py-1 rounded bg-secondary-container text-on-surface font-label-sm text-label-sm tracking-widest uppercase mb-space-sm">
            <span>Active Recall</span>
            <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
          </div>
          <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface tracking-tight font-semibold">
            Flashcard Decks
          </h1>
          <p className="font-body-md text-body-md text-on-surface-variant mt-1">
            Auto-generated from each study pack&apos;s key definitions and revision questions.
          </p>
        </div>

        {libraryItems.length > 0 && (
          <div className="flex flex-col gap-1 min-w-[240px]">
            <label
              htmlFor="deck-select"
              className="font-code text-[11px] uppercase tracking-wider text-on-surface-variant"
            >
              Active Lecture Deck
            </label>
            <select
              id="deck-select"
              value={deckId}
              onChange={(e) => onSelectDeck(e.target.value)}
              className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-code text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {libraryItems.map((item) => (
                <option key={item.jobId} value={item.jobId}>
                  {item.title || item.filename}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {deckError && (
        <div
          role="alert"
          className="rounded-xl border border-error bg-error-container/20 px-4 py-3 text-sm text-error flex items-center justify-between gap-3 font-code"
        >
          <span>{deckError}</span>
          <button
            type="button"
            onClick={onRetryDeck}
            className="px-3 py-1 rounded bg-error text-on-error text-xs font-semibold cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {loadingDeck ? (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/50 p-12 text-center font-code text-sm text-on-surface-variant flex items-center justify-center gap-2">
          <span className="material-symbols-outlined animate-spin text-primary">
            sync
          </span>
          <span>Building flashcard deck from study pack...</span>
        </div>
      ) : !deckPack?.content ? (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/50 p-10 text-center space-y-3">
          <span className="material-symbols-outlined text-[42px] text-primary/70">
            style
          </span>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">
            Select a lecture pack to study
          </h2>
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md mx-auto">
            Upload a lecture transcript in Study Generator or pick any completed study pack from your Library.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2 flex-wrap">
            <button
              type="button"
              onClick={onGoToLibrary}
              className="px-4 py-2 rounded-lg bg-primary text-on-primary font-code text-xs font-semibold cursor-pointer"
            >
              Browse Library
            </button>
            <button
              type="button"
              onClick={onGoToGenerator}
              className="px-4 py-2 rounded-lg border border-outline-variant bg-surface font-code text-xs text-on-surface cursor-pointer"
            >
              Upload Lecture
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Deck Mastery & Filter Controls */}
          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/60 p-space-md space-y-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-code text-xs text-on-surface">
                <span className="font-semibold">{counts.mastered}</span> /{" "}
                <span>{counts.total}</span> cards mastered ({masteryPct}%)
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleShuffle}
                  className="px-2.5 py-1.5 rounded-lg border border-outline-variant bg-surface hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">
                    shuffle
                  </span>
                  <span>Shuffle</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAddingCustom((v) => !v)}
                  className="px-2.5 py-1.5 rounded-lg border border-outline-variant bg-surface hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">
                    add
                  </span>
                  <span>Add Card</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  disabled={allCards.length === 0}
                  className="px-2.5 py-1.5 rounded-lg bg-primary text-on-primary hover:bg-inverse-surface font-code text-xs font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[15px]">
                    download
                  </span>
                  <span>Export CSV</span>
                </button>
              </div>
            </div>

            {/* Progress track */}
            <div className="w-full h-2 rounded-full bg-surface-container-high overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${masteryPct}%` }}
              />
            </div>

            {/* Category filter chips */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: "all", label: `All (${counts.total})` },
                  { id: "definition", label: `Definitions (${counts.definitions})` },
                  { id: "question", label: `Revision Q&A (${counts.questions})` },
                  { id: "review", label: `Needs Review (${counts.review})` },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setFilterMode(tab.id)}
                    className={`px-2.5 py-1 rounded-md font-code text-xs transition-colors cursor-pointer ${
                      filterMode === tab.id
                        ? "bg-secondary-container text-on-surface font-semibold"
                        : "text-on-surface-variant hover:bg-surface-container"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowList((v) => !v)}
                className="font-code text-xs text-primary hover:underline cursor-pointer"
              >
                {showList ? "Hide card list" : "View all cards"}
              </button>
            </div>
          </div>

          {/* Custom Card Inline Form */}
          {addingCustom && (
            <form
              onSubmit={handleAddCustomCard}
              className="bg-surface-container-low rounded-xl border border-outline-variant/60 p-space-md space-y-3"
            >
              <p className="font-headline-sm text-sm font-semibold text-on-surface">
                Add Custom Flashcard
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={customFront}
                  onChange={(e) => setCustomFront(e.target.value)}
                  placeholder="Front (term or question)"
                  className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <input
                  type="text"
                  required
                  value={customBack}
                  onChange={(e) => setCustomBack(e.target.value)}
                  placeholder="Back (definition or answer)"
                  className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="px-3.5 py-1.5 rounded-lg bg-primary text-on-primary font-code text-xs font-semibold cursor-pointer"
                >
                  Save Card
                </button>
                <button
                  type="button"
                  onClick={() => setAddingCustom(false)}
                  className="px-3 py-1.5 rounded-lg border border-outline-variant bg-surface font-code text-xs text-on-surface cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Active Flip Card */}
          {currentCard ? (
            <div className="space-y-4">
              <div
                role="button"
                tabIndex={0}
                aria-label="Flashcard — click or press Space to flip"
                onClick={() => setIsFlipped((prev) => !prev)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setIsFlipped((prev) => !prev);
                  }
                }}
                className={`w-full min-h-[260px] rounded-2xl border-2 p-space-lg md:p-space-xl flex flex-col justify-between cursor-pointer transition-all shadow-sm select-none ${
                  isFlipped
                    ? "bg-surface-container-low border-tertiary/60"
                    : "bg-surface-container-lowest border-outline-variant hover:border-primary"
                }`}
              >
                <div className="flex items-center justify-between gap-2 font-code text-xs">
                  <span
                    className={`px-2 py-0.5 rounded uppercase tracking-wider font-semibold ${
                      isFlipped
                        ? "bg-tertiary-fixed text-on-tertiary-fixed"
                        : "bg-primary-fixed text-on-primary-fixed-variant"
                    }`}
                  >
                    {isFlipped
                      ? currentCard.type === "definition"
                        ? "Definition"
                        : "Answer"
                      : currentCard.type === "definition"
                      ? "Key Term"
                      : "Question"}
                  </span>

                  <span className="text-on-surface-variant">
                    Card {safeIndex + 1} of {filteredCards.length}
                  </span>
                </div>

                <div className="my-auto py-6 text-center">
                  {isFlipped ? (
                    <div className="markdown-content text-left max-w-2xl mx-auto text-base md:text-lg text-on-surface">
                      <ReactMarkdown>{currentCard.back}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="font-headline-sm text-lg md:text-2xl font-medium text-on-surface max-w-2xl mx-auto leading-snug">
                      {currentCard.front}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between text-xs font-code text-on-surface-variant">
                  <span>
                    Status:{" "}
                    <strong className="uppercase text-on-surface">
                      {masteryMap[currentCard.id] || "unrated"}
                    </strong>
                  </span>
                  <span>Click or press Space to {isFlipped ? "show prompt" : "reveal answer"}</span>
                </div>
              </div>

              {/* Navigation & Self-Rating Bar */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsFlipped(false);
                      setCardIndex((prev) =>
                        prev - 1 < 0 ? filteredCards.length - 1 : prev - 1
                      );
                    }}
                    className="px-3.5 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      arrow_back
                    </span>
                    <span>Prev</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsFlipped((prev) => !prev)}
                    className="px-4 py-2 rounded-lg border border-primary/50 bg-surface-container-lowest hover:bg-primary/5 font-code text-xs font-semibold text-primary cursor-pointer"
                  >
                    {isFlipped ? "Show Prompt" : "Flip Card"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsFlipped(false);
                      setCardIndex((prev) => (prev + 1) % filteredCards.length);
                    }}
                    className="px-3.5 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1 cursor-pointer"
                  >
                    <span>Next</span>
                    <span className="material-symbols-outlined text-[16px]">
                      arrow_forward
                    </span>
                  </button>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setCardMastery(currentCard.id, "review")}
                    className="px-3 py-2 rounded-lg border border-error/40 bg-error-container/25 text-on-error-container hover:bg-error-container/40 font-code text-xs font-semibold cursor-pointer"
                  >
                    Needs Review
                  </button>
                  <button
                    type="button"
                    onClick={() => setCardMastery(currentCard.id, "familiar")}
                    className="px-3 py-2 rounded-lg bg-secondary-container text-on-surface hover:bg-surface-container-highest font-code text-xs font-semibold cursor-pointer"
                  >
                    Familiar
                  </button>
                  <button
                    type="button"
                    onClick={() => setCardMastery(currentCard.id, "mastered")}
                    className="px-3 py-2 rounded-lg bg-tertiary text-on-tertiary hover:bg-tertiary-container font-code text-xs font-semibold cursor-pointer"
                  >
                    Mastered
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/50 p-8 text-center font-code text-sm text-on-surface-variant">
              {allCards.length === 0
                ? "No structured definitions or revision questions could be parsed from this study pack."
                : "All cards in this filter are mastered! Switch filter to All Cards to keep reviewing."}
            </div>
          )}

          {/* Optional Expandable Card Overview List */}
          {showList && allCards.length > 0 && (
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/60 divide-y divide-outline-variant/30 overflow-hidden">
              {allCards.map((c, idx) => (
                <div
                  key={c.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3 hover:bg-surface-container-low/60"
                >
                  <div className="space-y-1 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-code text-xs text-on-surface-variant">
                        #{idx + 1}
                      </span>
                      <span className="font-code text-[11px] uppercase px-1.5 py-0.5 rounded bg-secondary-container text-on-secondary-fixed-variant">
                        {c.type}
                      </span>
                      {masteryMap[c.id] && (
                        <span className="font-code text-[11px] uppercase text-primary font-semibold">
                          · {masteryMap[c.id]}
                        </span>
                      )}
                    </div>
                    <p className="font-medium text-sm text-on-surface">
                      {c.front}
                    </p>
                    <p className="text-xs text-on-surface-variant whitespace-pre-line">
                      {c.back}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
