import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import axios from "axios";
import LibraryView from "./components/LibraryView";
import DecksView from "./components/DecksView";
import LectureChatPanel from "./components/LectureChatPanel";

const API_BASE = "https://68sw2jy582.execute-api.ap-southeast-2.amazonaws.com/prod";
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_POLL_ATTEMPTS = 200; // ~10 minutes at 3s interval

function tabFromHash() {
  const hash = (window.location.hash || "").toLowerCase();
  if (hash === "#library") return "library";
  if (hash === "#decks") return "decks";
  return "generator";
}

export default function App() {
  const [activeTab, setActiveTab] = useState(tabFromHash);

  // Study Generator state
  const [file, setFile] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [stage, setStage] = useState("idle"); // idle | requesting | uploading | processing | complete | error
  const [statusMessage, setStatusMessage] = useState("");
  const [studyPack, setStudyPack] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [navNotice, setNavNotice] = useState("");
  const fileInputRef = useRef(null);
  const resultsRef = useRef(null);

  // Library & Decks shared state
  const [libraryItems, setLibraryItems] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [packCache, setPackCache] = useState({}); // jobId -> full pack object
  const [loadingPackId, setLoadingPackId] = useState("");
  const [activeReaderJobId, setActiveReaderJobId] = useState("");
  const [selectedDeckJobId, setSelectedDeckJobId] = useState("");
  const [deckError, setDeckError] = useState("");

  const switchTab = useCallback((nextTab) => {
    setActiveTab(nextTab);
    setNavNotice("");
    const targetHash = nextTab === "generator" ? "#generator" : `#${nextTab}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, "", targetHash);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const fetchLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryError("");
    try {
      const { data } = await axios.get(`${API_BASE}/library`, { timeout: 15000 });
      setLibraryItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      setLibraryError(
        `Could not load library: ${err.response?.data?.message || err.message}`
      );
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLibrary();
  }, [fetchLibrary]);

  const fetchLibraryPack = useCallback(
    async (targetJobId) => {
      if (!targetJobId) return null;
      if (packCache[targetJobId]?.content) {
        return packCache[targetJobId];
      }
      setLoadingPackId(targetJobId);
      setDeckError("");
      try {
        const { data } = await axios.get(`${API_BASE}/library/${targetJobId}`, {
          timeout: 15000,
        });
        setPackCache((prev) => ({ ...prev, [targetJobId]: data }));
        return data;
      } catch (err) {
        const msg = `Could not retrieve study pack: ${
          err.response?.data?.message || err.message
        }`;
        setLibraryError(msg);
        setDeckError(msg);
        return null;
      } finally {
        setLoadingPackId("");
      }
    },
    [packCache]
  );

  // Auto-load the active or newest deck when user enters DECKS tab
  useEffect(() => {
    if (activeTab !== "decks") return;
    if (selectedDeckJobId && packCache[selectedDeckJobId]?.content) return;

    const candidateId =
      selectedDeckJobId ||
      (jobId && studyPack ? jobId : "") ||
      (libraryItems[0]?.jobId || "");

    if (candidateId) {
      setSelectedDeckJobId(candidateId);
      if (!packCache[candidateId]?.content) {
        fetchLibraryPack(candidateId);
      }
    }
  }, [
    activeTab,
    selectedDeckJobId,
    jobId,
    studyPack,
    libraryItems,
    packCache,
    fetchLibraryPack,
  ]);

  const formatFileSize = (bytes) => {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const validateAndStageFile = (selected) => {
    if (!selected) return;
    const lowerName = selected.name.toLowerCase();
    const isValidExt = lowerName.endsWith(".txt") || lowerName.endsWith(".pdf");

    if (!isValidExt) {
      setFile(null);
      setJobId(null);
      setStudyPack("");
      setDownloadUrl("");
      setCopied(false);
      setStage("error");
      setStatusMessage("Unsupported file format. Please upload a .txt or .pdf lecture transcript.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    if (selected.size > MAX_FILE_SIZE_BYTES) {
      setFile(null);
      setJobId(null);
      setStudyPack("");
      setDownloadUrl("");
      setCopied(false);
      setStage("error");
      setStatusMessage("File exceeds the 50 MB size limit. Please upload a smaller transcript.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setFile(selected);
    setJobId(null);
    setStudyPack("");
    setDownloadUrl("");
    setCopied(false);
    setStage("idle");
    setStatusMessage("");
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndStageFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndStageFile(e.target.files[0]);
    }
  };

  const handleDropZoneKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const handleRemoveFile = (e) => {
    e.stopPropagation();
    setFile(null);
    setJobId(null);
    setStudyPack("");
    setDownloadUrl("");
    setCopied(false);
    setStage("idle");
    setStatusMessage("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleUploadAndGenerate = async () => {
    if (!file) return;

    try {
      setStage("requesting");
      setStatusMessage("Requesting secure presigned S3 upload URL...");
      setStudyPack("");
      setDownloadUrl("");
      setCopied(false);

      const { data } = await axios.post(`${API_BASE}/upload-url`, {
        filename: file.name,
      });

      const currentJobId = data.jobId;
      setJobId(currentJobId);

      setStage("uploading");
      setStatusMessage("Uploading lecture transcript directly to S3 bucket...");

      await axios.put(data.uploadUrl, file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
      });

      setStage("processing");
      setStatusMessage("Extracting text and generating synthesis study pack via Groq LLM...");
    } catch (err) {
      setStage("error");
      setStatusMessage(`Upload failed: ${err.response?.data?.message || err.message}`);
    }
  };

  // Sequential polling loop (avoids overlapping requests and infinite spinners)
  useEffect(() => {
    if (!jobId || stage !== "processing") return;

    let cancelled = false;
    let timeoutId = null;
    let pollAttempts = 0;
    let consecutiveServerErrors = 0;

    const pollOnce = async () => {
      if (cancelled) return;
      pollAttempts += 1;

      if (pollAttempts > MAX_POLL_ATTEMPTS) {
        setStage("error");
        setStatusMessage("Processing timed out after 10 minutes. Please try uploading again.");
        return;
      }

      try {
        const { data } = await axios.get(`${API_BASE}/status/${jobId}`, {
          timeout: 15000,
        });
        if (cancelled) return;
        consecutiveServerErrors = 0;

        if (data.status === "processing") {
          setStatusMessage(
            data.message
              ? `${data.message} (${pollAttempts * 3}s elapsed)`
              : `Processing lecture chunk synthesis in background... (${pollAttempts * 3}s elapsed)`
          );
        } else if (data.status === "complete") {
          const dlUrl = data.downloadUrl || "";
          setDownloadUrl(dlUrl);
          setStatusMessage("Retrieving generated study pack from S3...");

          let markdownText = "";
          if (dlUrl) {
            try {
              const res = await axios.get(dlUrl, { timeout: 15000 });
              markdownText =
                typeof res.data === "string"
                  ? res.data
                  : JSON.stringify(res.data, null, 2);
            } catch {
              const fallback = await fetchLibraryPack(jobId);
              markdownText = fallback?.content || "";
            }
          } else {
            const fallback = await fetchLibraryPack(jobId);
            markdownText = fallback?.content || "";
          }

          if (cancelled) return;

          const displayName = data.filename || file?.name || `Lecture ${jobId.slice(0, 8)}`;
          if (markdownText) {
            setStudyPack(markdownText);
            setPackCache((prev) => ({
              ...prev,
              [jobId]: {
                jobId,
                filename: displayName,
                title: displayName.replace(/\.(txt|pdf)$/i, ""),
                content: markdownText,
                downloadUrl: dlUrl,
              },
            }));
            setStage("complete");
            setStatusMessage("Synthesis complete! Study pack saved to Library.");
            fetchLibrary();
            setTimeout(() => {
              resultsRef.current?.scrollIntoView({ behavior: "smooth" });
            }, 150);
          } else {
            setStage("error");
            setStatusMessage(
              "Study pack completed, but content could not be downloaded. Check the Library tab to retry."
            );
            fetchLibrary();
          }
          return;
        } else if (data.status === "error") {
          setStage("error");
          setStatusMessage(
            `Synthesis failed: ${data.message || "Unknown error during AI generation."}`
          );
          return;
        }
      } catch (err) {
        if (cancelled) return;
        const code = err?.response?.status;
        if (code && code !== 404) {
          consecutiveServerErrors += 1;
          if (consecutiveServerErrors >= 8) {
            setStage("error");
            setStatusMessage(
              `Status polling failed (HTTP ${code}). Please refresh or check Library.`
            );
            return;
          }
        }
      }

      if (!cancelled) {
        timeoutId = setTimeout(pollOnce, 3000);
      }
    };

    timeoutId = setTimeout(pollOnce, 3000);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [jobId, stage, file?.name, fetchLibrary, fetchLibraryPack]);

  const handleCopyMarkdown = () => {
    if (!studyPack) return;
    navigator.clipboard.writeText(studyPack);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadMarkdown = () => {
    if (studyPack) {
      const baseName = file?.name ? file.name.replace(/\.(txt|pdf)$/i, "") : "lecture";
      const blob = new Blob([studyPack], { type: "text/markdown;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `${baseName}_study_pack.md`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
      return;
    }

    if (downloadUrl) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
    }
  };

  const showNavNotice = (msg) => {
    setNavNotice(msg);
    setTimeout(() => setNavNotice(""), 3500);
  };

  const handleOpenLibraryPack = async (targetJobId) => {
    setActiveReaderJobId(targetJobId);
    await fetchLibraryPack(targetJobId);
  };

  const handleOpenDeckForJob = async (targetJobId) => {
    setSelectedDeckJobId(targetJobId);
    switchTab("decks");
    await fetchLibraryPack(targetJobId);
  };

  const isBusy = stage === "uploading" || stage === "processing" || stage === "requesting";
  const activeReaderPack = activeReaderJobId ? packCache[activeReaderJobId] || null : null;
  const activeDeckPack = selectedDeckJobId ? packCache[selectedDeckJobId] || null : null;

  const navBtnClass = (tabName) =>
    tabName === activeTab
      ? "bg-secondary-container text-on-surface font-label-md text-xs sm:text-label-md rounded px-2.5 sm:px-space-sm py-space-xs font-medium whitespace-nowrap cursor-pointer transition-colors"
      : "font-label-md text-xs sm:text-label-md text-on-surface-variant hover:text-on-surface transition-colors whitespace-nowrap px-2 py-space-xs rounded cursor-pointer";

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      {/* Navigation Header */}
      <header className="fixed top-0 w-full z-50 bg-surface/90 backdrop-blur-md border-b border-outline-variant/20">
        <div className="min-h-16 w-full px-margin-mobile md:px-margin py-2 sm:py-0 flex flex-wrap sm:flex-nowrap items-center justify-between gap-y-2 gap-x-2">
          <button
            type="button"
            onClick={() => switchTab("generator")}
            className="flex items-center gap-1.5 sm:gap-space-sm shrink-0 cursor-pointer"
          >
            <span className="font-label-md text-xs sm:text-label-md tracking-wider uppercase text-on-surface font-semibold whitespace-nowrap">
              LECTURE // STUDY
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0"></span>
          </button>

          <nav
            aria-label="Primary sections"
            className="order-3 sm:order-2 w-full sm:w-auto flex items-center justify-center gap-2 sm:gap-space-lg"
          >
            <button
              type="button"
              onClick={() => switchTab("generator")}
              aria-current={activeTab === "generator" ? "page" : undefined}
              className={navBtnClass("generator")}
            >
              STUDY GENERATOR
            </button>
            <button
              type="button"
              onClick={() => {
                switchTab("library");
                if (libraryItems.length === 0) fetchLibrary();
              }}
              aria-current={activeTab === "library" ? "page" : undefined}
              className={navBtnClass("library")}
            >
              LIBRARY{libraryItems.length > 0 ? ` (${libraryItems.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => switchTab("decks")}
              aria-current={activeTab === "decks" ? "page" : undefined}
              className={navBtnClass("decks")}
            >
              DECKS
            </button>
          </nav>

          <div className="order-2 sm:order-3 flex items-center shrink-0">
            <button
              type="button"
              aria-label="Session info"
              onClick={() =>
                showNavNotice("Cloud workspace active — generated study packs persist in S3 Library.")
              }
              className="w-8 h-8 rounded-full bg-primary flex items-center justify-center cursor-pointer shadow-sm hover:bg-inverse-surface transition-colors"
            >
              <span className="material-symbols-outlined text-on-primary text-[18px]">
                person
              </span>
            </button>
          </div>
        </div>

        {navNotice && (
          <div className="w-full bg-surface-container-high border-t border-outline-variant/30 px-margin-mobile md:px-margin py-1.5 text-center font-code text-xs text-on-surface-variant">
            {navNotice}
          </div>
        )}
      </header>

      {/* Main Workspace */}
      <main id="top" className="flex-1 w-full pt-24 sm:pt-16 bg-surface px-margin-mobile md:px-margin">
        {activeTab === "library" ? (
          <LibraryView
            items={libraryItems}
            loading={libraryLoading}
            error={libraryError}
            activeReaderPack={activeReaderPack}
            loadingPackId={loadingPackId}
            onRefresh={fetchLibrary}
            onOpenPack={handleOpenLibraryPack}
            onCloseReader={() => setActiveReaderJobId("")}
            onOpenDeck={handleOpenDeckForJob}
            onGoToGenerator={() => switchTab("generator")}
          />
        ) : activeTab === "decks" ? (
          <DecksView
            libraryItems={libraryItems}
            selectedDeckJobId={selectedDeckJobId}
            deckPack={activeDeckPack}
            loadingDeck={loadingPackId === selectedDeckJobId && Boolean(selectedDeckJobId)}
            deckError={deckError}
            onSelectDeck={(targetId) => handleOpenDeckForJob(targetId)}
            onRetryDeck={() => fetchLibraryPack(selectedDeckJobId)}
            onGoToLibrary={() => switchTab("library")}
            onGoToGenerator={() => switchTab("generator")}
          />
        ) : (
          <div className="flex flex-col w-full">
            <div className="w-full max-w-5xl mx-auto py-space-lg md:py-space-xl flex flex-col items-center">
              {/* Header Section */}
              <div className="text-center max-w-2xl flex flex-col items-center mb-space-lg md:mb-space-xl">
                <div className="inline-flex items-center gap-space-xs px-2.5 py-1 rounded bg-secondary-container text-on-surface font-label-sm text-label-sm tracking-widest uppercase mb-space-md">
                  <span>
                    {stage === "idle"
                      ? "Terminal Ready"
                      : stage === "processing"
                      ? "Processing Active"
                      : stage === "complete"
                      ? "Synthesis Complete"
                      : stage === "error"
                      ? "Terminal Error"
                      : "Connecting"}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      stage === "error"
                        ? "bg-error"
                        : stage === "complete"
                        ? "bg-tertiary-container"
                        : "bg-primary animate-pulse"
                    }`}
                  ></span>
                </div>
                <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface tracking-tight mb-space-sm font-semibold">
                  Lecture-to-Study Material Generator
                </h1>
                <p className="font-body-md md:font-body-lg text-body-md md:text-body-lg text-on-surface opacity-80">
                  Turn recorded lectures and course transcripts into structured study notes, summaries, and exam prep.
                </p>
              </div>

              {/* Central Workspace / Upload Container */}
              <div className="w-full max-w-3xl flex flex-col items-center">
                {/* Drag & Drop Zone */}
                <div
                  id="drop-area"
                  role="button"
                  tabIndex={0}
                  aria-label="Upload lecture transcript (.txt or .pdf, up to 50MB)"
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={handleDropZoneKeyDown}
                  onDrop={handleFileDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={`w-full bg-surface-container-lowest rounded-xl border-2 border-dashed ${
                    isDragging
                      ? "border-primary bg-surface-container-high scale-[1.01]"
                      : "border-primary hover:bg-surface-container-low"
                  } p-space-lg md:p-space-xl flex flex-col items-center justify-center text-center transition-all cursor-pointer group focus:outline-none focus:ring-2 focus:ring-primary/50`}
                >
                  {/* Icon Container */}
                  <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-primary/10 flex items-center justify-center mb-space-md text-primary group-hover:scale-105 transition-transform">
                    <span className="material-symbols-outlined text-[32px] md:text-[36px]">
                      upload_file
                    </span>
                  </div>

                  {/* Instructions */}
                  <p className="font-headline-sm text-base md:text-headline-sm text-on-surface mb-space-xs">
                    Drag and drop your lecture file here, or{" "}
                    <span className="text-primary underline underline-offset-4 decoration-primary/40 group-hover:decoration-primary font-medium">
                      browse
                    </span>
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mb-space-lg">
                    Supports TXT or PDF up to 50MB
                  </p>

                  {/* Selected File Pill Display */}
                  {file ? (
                    <div
                      id="file-badge"
                      className="inline-flex items-center gap-space-sm px-4 py-2 rounded-full border border-outline-variant bg-surface text-on-surface font-code text-code shadow-sm max-w-full"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="material-symbols-outlined text-primary text-[18px] shrink-0">
                        description
                      </span>
                      <span className="font-medium text-on-surface truncate max-w-[180px] sm:max-w-[280px]">
                        {file.name}
                      </span>
                      <span className="text-on-surface-variant font-normal shrink-0">
                        ({formatFileSize(file.size)})
                      </span>
                      <button
                        type="button"
                        aria-label="Remove selected file"
                        onClick={handleRemoveFile}
                        className="ml-space-xs text-on-surface-variant hover:text-primary transition-colors flex items-center justify-center p-0.5 rounded-full hover:bg-surface-container shrink-0"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          close
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className="text-on-surface-variant/60 font-code text-[0.8rem]">
                      No file currently staged
                    </div>
                  )}

                  <input
                    ref={fileInputRef}
                    id="lecture-input"
                    type="file"
                    accept=".txt,.pdf"
                    onChange={handleFileInputChange}
                    className="hidden"
                  />
                </div>

                {/* Action Area */}
                <div className="mt-space-lg md:mt-space-xl flex flex-col sm:flex-row items-center justify-center gap-space-md w-full">
                  <button
                    type="button"
                    id="generate-btn"
                    onClick={handleUploadAndGenerate}
                    disabled={!file || isBusy}
                    className={`w-full sm:w-auto sm:min-w-[280px] font-headline-sm text-base sm:text-headline-sm font-semibold rounded-xl px-6 sm:px-8 py-3.5 flex items-center justify-center gap-space-sm transition-all active:translate-y-px ${
                      !file || isBusy
                        ? "bg-secondary-fixed text-on-secondary-fixed-variant opacity-60 cursor-not-allowed"
                        : "bg-primary text-on-primary hover:bg-inverse-surface shadow-md cursor-pointer"
                    }`}
                  >
                    <span
                      className={`material-symbols-outlined text-[20px] ${
                        stage === "processing" ? "animate-spin" : ""
                      }`}
                    >
                      {stage === "processing" ? "sync" : "auto_awesome"}
                    </span>
                    <span className="whitespace-nowrap">
                      {stage === "requesting"
                        ? "Requesting URL..."
                        : stage === "uploading"
                        ? "Uploading to S3..."
                        : stage === "processing"
                        ? "Synthesizing Material..."
                        : "Generate Study Material"}
                    </span>
                  </button>
                </div>

                {/* Live Status Card */}
                {statusMessage && (
                  <div
                    className={`w-full mt-space-lg p-space-md rounded-xl border flex items-start gap-space-sm font-code text-code transition-all ${
                      stage === "error"
                        ? "bg-error-container/20 border-error text-error"
                        : stage === "complete"
                        ? "bg-surface-container-high border-tertiary text-on-surface"
                        : "bg-surface-container border-outline-variant/60 text-on-surface"
                    }`}
                  >
                    <span
                      className={`material-symbols-outlined text-[20px] shrink-0 ${
                        stage === "error" ? "text-error" : "text-primary"
                      }`}
                    >
                      {stage === "error"
                        ? "error"
                        : stage === "complete"
                        ? "check_circle"
                        : "terminal"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <span className="font-semibold uppercase text-xs tracking-wider">
                          STATUS // {stage}
                        </span>
                        {jobId && (
                          <span className="text-xs text-on-surface-variant font-mono">
                            ID: {jobId.slice(0, 8)}...
                          </span>
                        )}
                      </div>
                      <p className="text-sm break-words">{statusMessage}</p>
                    </div>
                  </div>
                )}

                {/* Technical Parameters Footer */}
                <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-space-md mt-space-xl pt-space-md border-t border-outline-variant/30 text-on-surface-variant font-code text-code">
                  <div className="flex items-center gap-space-sm">
                    <span className="material-symbols-outlined text-[18px] text-primary">
                      verified
                    </span>
                    <span>Automatic synthesis parsing</span>
                  </div>
                  <div className="flex items-center gap-space-sm justify-start md:justify-center">
                    <span className="material-symbols-outlined text-[18px] text-primary">
                      schedule
                    </span>
                    <span>~1–2m turnaround latency</span>
                  </div>
                  <div className="flex items-center gap-space-sm justify-start md:justify-end">
                    <span className="material-symbols-outlined text-[18px] text-primary">
                      folder_special
                    </span>
                    <span>S3 Library &amp; Deck persistence</span>
                  </div>
                </div>
              </div>

              {/* Results / Generated Study Pack Viewer */}
              {studyPack && (
                <div
                  ref={resultsRef}
                  className="w-full max-w-4xl mt-space-xl pt-space-xl border-t-2 border-outline-variant/30 flex flex-col"
                >
                  {/* Result Controls Header */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-space-md mb-space-lg bg-surface-container-low p-space-md rounded-xl border border-outline-variant/40">
                    <div className="flex items-center gap-space-sm">
                      <span className="material-symbols-outlined text-primary text-[24px]">
                        menu_book
                      </span>
                      <div>
                        <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                          Generated Study Pack
                        </h2>
                        <p className="font-code text-xs text-on-surface-variant">
                          Structured summary, key definitions &amp; revision questions
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-space-sm flex-wrap">
                      {jobId && (
                        <button
                          type="button"
                          onClick={() => handleOpenDeckForJob(jobId)}
                          className="px-4 py-2 rounded-lg border border-tertiary/40 bg-tertiary-fixed/40 text-on-tertiary-fixed hover:bg-tertiary-fixed font-code text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[16px]">
                            style
                          </span>
                          <span>Study in Decks</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleCopyMarkdown}
                        className="px-4 py-2 rounded-lg border border-outline-variant bg-surface hover:bg-surface-container font-code text-xs text-on-surface flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {copied ? "done" : "content_copy"}
                        </span>
                        <span>{copied ? "Copied!" : "Copy Markdown"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadMarkdown}
                        className="px-4 py-2 rounded-lg bg-primary text-on-primary hover:bg-inverse-surface font-code text-xs font-semibold flex items-center gap-1.5 shadow transition-colors cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          download
                        </span>
                        <span>Download (.md)</span>
                      </button>
                    </div>
                  </div>

                  {/* Markdown Viewer */}
                  <div className="w-full bg-surface-container-lowest rounded-xl border border-outline-variant/50 p-space-lg md:p-space-xl shadow-sm markdown-content">
                    <ReactMarkdown>{studyPack}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Chat With This Lecture Panel (disabled until processing completes) */}
              {(stage !== "idle" || Boolean(studyPack)) && (
                <div className="w-full max-w-4xl mt-space-lg">
                  <LectureChatPanel
                    jobId={jobId}
                    studyPack={studyPack}
                    isReady={stage === "complete" && Boolean(studyPack)}
                    apiBase={API_BASE}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Terminal Footer */}
      <footer className="w-full bg-surface py-space-lg md:py-space-xl mt-space-lg md:mt-space-xl border-t border-outline-variant/20">
        <div className="w-full px-margin-mobile md:px-margin flex flex-col md:flex-row items-center justify-between text-on-surface-variant font-code text-code gap-2 text-center">
          <p>LECTURE // STUDY SYNTHESIS TERMINAL</p>
          <p>DISCIPLINED COGNITIVE RETENTION</p>
        </div>
      </footer>
    </div>
  );
}
