import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { formatStudyDate } from "../utils/studyPackParser";
import LectureChatPanel from "./LectureChatPanel";

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function LibraryView({
  items,
  loading,
  error,
  activeReaderPack,
  loadingPackId,
  onRefresh,
  onOpenPack,
  onCloseReader,
  onOpenDeck,
  onGoToGenerator,
}) {
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState("");

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        (item.title || "").toLowerCase().includes(q) ||
        (item.filename || "").toLowerCase().includes(q) ||
        (item.summarySnippet || "").toLowerCase().includes(q) ||
        (item.jobId || "").toLowerCase().includes(q)
    );
  }, [items, query]);

  const handleCopyReader = (pack) => {
    if (!pack?.content) return;
    navigator.clipboard.writeText(pack.content);
    setCopiedId(pack.jobId);
    setTimeout(() => setCopiedId(""), 2000);
  };

  const handleDownloadPack = (pack) => {
    if (pack?.content) {
      const base = (pack.title || pack.filename || "lecture")
        .replace(/\.(txt|pdf)$/i, "")
        .trim();
      const blob = new Blob([pack.content], {
        type: "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${base || "lecture"}_study_pack.md`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }
    if (pack?.downloadUrl) {
      window.open(pack.downloadUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto py-space-lg md:py-space-xl flex flex-col gap-space-lg">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
        <div>
          <div className="inline-flex items-center gap-space-xs px-2.5 py-1 rounded bg-secondary-container text-on-surface font-label-sm text-label-sm tracking-widest uppercase mb-space-sm">
            <span>Study Archive</span>
            <span className="w-1.5 h-1.5 rounded-full bg-tertiary-container"></span>
          </div>
          <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface tracking-tight font-semibold">
            Study Pack Library
          </h1>
          <p className="font-body-md text-body-md text-on-surface-variant mt-1">
            Browse generated lecture notes, download Markdown study packs, or launch interactive flashcard decks.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="px-3.5 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          >
            <span
              className={`material-symbols-outlined text-[16px] ${
                loading ? "animate-spin" : ""
              }`}
            >
              refresh
            </span>
            <span>{loading ? "Syncing..." : "Refresh Library"}</span>
          </button>
          <button
            type="button"
            onClick={onGoToGenerator}
            className="px-3.5 py-2 rounded-lg bg-primary text-on-primary hover:bg-inverse-surface font-code text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span>New Upload</span>
          </button>
        </div>
      </div>

      {/* Inline Reader when a Library Pack is opened */}
      {activeReaderPack && (
        <section className="w-full bg-surface-container-lowest rounded-xl border-2 border-primary/40 shadow-sm overflow-hidden">
          <div className="bg-surface-container-low px-space-md sm:px-space-lg py-space-md border-b border-outline-variant/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="material-symbols-outlined text-primary text-[20px]">
                  menu_book
                </span>
                <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold truncate">
                  {activeReaderPack.title || activeReaderPack.filename}
                </h2>
              </div>
              <p className="font-code text-xs text-on-surface-variant mt-0.5 truncate">
                {activeReaderPack.filename} · {formatBytes(activeReaderPack.sizeBytes)}
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <button
                type="button"
                onClick={() => onOpenDeck(activeReaderPack.jobId)}
                className="px-3 py-1.5 rounded-lg bg-tertiary text-on-tertiary hover:bg-tertiary-container font-code text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">style</span>
                <span>Study Flashcards</span>
              </button>
              <button
                type="button"
                onClick={() => handleCopyReader(activeReaderPack)}
                className="px-3 py-1.5 rounded-lg border border-outline-variant bg-surface hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {copiedId === activeReaderPack.jobId ? "done" : "content_copy"}
                </span>
                <span>
                  {copiedId === activeReaderPack.jobId ? "Copied!" : "Copy"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleDownloadPack(activeReaderPack)}
                className="px-3 py-1.5 rounded-lg bg-primary text-on-primary hover:bg-inverse-surface font-code text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">
                  download
                </span>
                <span>.md</span>
              </button>
              <button
                type="button"
                aria-label="Close reader"
                onClick={onCloseReader}
                className="p-1.5 rounded-lg border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
          </div>

          <div className="p-space-md sm:p-space-xl markdown-content max-h-[68vh] overflow-y-auto">
            <ReactMarkdown>{activeReaderPack.content}</ReactMarkdown>
          </div>
          <div className="px-space-md sm:px-space-xl pb-space-lg pt-space-md border-t border-outline-variant/30 bg-surface-container-low/40">
            <LectureChatPanel
              jobId={activeReaderPack.jobId}
              studyPack={activeReaderPack.content}
              isReady={Boolean(activeReaderPack.content)}
              apiBase="https://68sw2jy582.execute-api.ap-southeast-2.amazonaws.com/prod"
            />
          </div>
        </section>
      )}

      {/* Search & Count Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <span className="material-symbols-outlined text-on-surface-variant text-[18px] absolute left-3 top-1/2 -translate-y-1/2">
            search
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by lecture title, filename, or summary..."
            aria-label="Filter library study packs"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <div className="font-code text-xs text-on-surface-variant">
          Showing {filteredItems.length} of {items.length} study pack
          {items.length === 1 ? "" : "s"}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-error bg-error-container/20 px-4 py-3 text-sm text-error flex items-center justify-between gap-3 font-code"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={onRefresh}
            className="px-3 py-1 rounded bg-error text-on-error text-xs font-semibold cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/50 p-10 text-center font-code text-sm text-on-surface-variant flex items-center justify-center gap-2">
          <span className="material-symbols-outlined animate-spin text-primary">
            sync
          </span>
          <span>Loading saved study packs from S3...</span>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/50 p-10 text-center space-y-3">
          <span className="material-symbols-outlined text-[40px] text-on-surface-variant/50">
            folder_open
          </span>
          <p className="font-headline-sm text-headline-sm text-on-surface">
            {items.length === 0
              ? "No study packs in S3 Library yet"
              : "No study packs match your search"}
          </p>
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md mx-auto">
            Upload a lecture transcript in Study Generator to automatically archive notes and unlock flashcard decks.
          </p>
          {items.length === 0 && (
            <button
              type="button"
              onClick={onGoToGenerator}
              className="mt-2 px-4 py-2 rounded-lg bg-primary text-on-primary font-code text-xs font-semibold cursor-pointer"
            >
              Go to Study Generator
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          {filteredItems.map((item) => {
            const isOpening = loadingPackId === item.jobId;
            const isSelected = activeReaderPack?.jobId === item.jobId;
            const isPdf = (item.filename || "").toLowerCase().endsWith(".pdf");

            return (
              <article
                key={item.jobId}
                className={`bg-surface-container-lowest rounded-xl border p-space-md flex flex-col justify-between gap-space-md transition-all shadow-sm ${
                  isSelected
                    ? "border-primary ring-1 ring-primary/30"
                    : "border-outline-variant/60 hover:border-outline"
                }`}
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="material-symbols-outlined text-primary text-[20px] shrink-0">
                        {isPdf ? "picture_as_pdf" : "description"}
                      </span>
                      <h2 className="font-headline-sm text-base font-semibold text-on-surface truncate">
                        {item.title || item.filename}
                      </h2>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-fixed-variant font-code text-[11px] uppercase shrink-0">
                      {isPdf ? "PDF" : "TXT"}
                    </span>
                  </div>

                  <p className="font-code text-xs text-on-surface-variant flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{formatStudyDate(item.lastModified)}</span>
                    <span>·</span>
                    <span>{formatBytes(item.sizeBytes)}</span>
                    <span>·</span>
                    <span className="opacity-75">ID: {item.jobId.slice(0, 8)}</span>
                  </p>

                  {item.summarySnippet && (
                    <p className="font-body-sm text-body-sm text-on-surface/80 line-clamp-3 leading-relaxed">
                      {item.summarySnippet}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-outline-variant/30">
                  <button
                    type="button"
                    disabled={isOpening}
                    onClick={() => onOpenPack(item.jobId)}
                    className="px-3 py-1.5 rounded-lg bg-primary text-on-primary hover:bg-inverse-surface font-code text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60"
                  >
                    <span className="material-symbols-outlined text-[15px]">
                      {isOpening ? "sync" : "menu_book"}
                    </span>
                    <span>{isOpening ? "Opening..." : "Read Pack"}</span>
                  </button>

                  <button
                    type="button"
                    disabled={isOpening}
                    onClick={() => onOpenDeck(item.jobId)}
                    className="px-3 py-1.5 rounded-lg border border-tertiary/40 bg-tertiary-fixed/40 text-on-tertiary-fixed hover:bg-tertiary-fixed font-code text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60"
                  >
                    <span className="material-symbols-outlined text-[15px]">
                      style
                    </span>
                    <span>Flashcard Deck</span>
                  </button>

                  {item.downloadUrl && (
                    <a
                      href={item.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto px-2.5 py-1.5 rounded-lg border border-outline-variant bg-surface hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[15px]">
                        download
                      </span>
                      <span>.md</span>
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
