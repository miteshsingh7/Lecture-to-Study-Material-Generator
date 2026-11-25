import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import axios from "axios";
import { parseStudyPackCards } from "../utils/studyPackParser";

const MAX_QUESTION_CHARS = 500;

function deriveSuggestedQuestions(studyPack, jobId) {
  if (!studyPack) return [];
  const cards = parseStudyPackCards(studyPack, jobId || "session");
  const defs = cards.filter((c) => c.type === "definition");
  const qs = cards.filter((c) => c.type === "question");

  const suggestions = [];
  for (const q of qs.slice(0, 2)) {
    if (q.front && q.front.length <= 160) {
      suggestions.push(q.front);
    }
  }
  for (const d of defs.slice(0, 2)) {
    if (d.front && d.front.length <= 80) {
      suggestions.push(`What is ${d.front} according to this lecture?`);
    }
  }
  return Array.from(new Set(suggestions)).slice(0, 4);
}

export default function LectureChatPanel({
  jobId,
  studyPack,
  isReady,
  apiBase,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");
  const [expandedSources, setExpandedSources] = useState({});
  const listEndRef = useRef(null);

  useEffect(() => {
    setMessages([]);
    setInput("");
    setErrorBanner("");
    setExpandedSources({});
  }, [jobId]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const suggestedQuestions = useMemo(
    () => deriveSuggestedQuestions(studyPack, jobId),
    [studyPack, jobId]
  );

  const toggleSources = (msgIdx) => {
    setExpandedSources((prev) => ({ ...prev, [msgIdx]: !prev[msgIdx] }));
  };

  const sendQuestion = async (rawText) => {
    const trimmed = String(rawText || "").trim().slice(0, MAX_QUESTION_CHARS);
    if (!trimmed || !isReady || !jobId || sending) return;

    setErrorBanner("");
    const historyTurns = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    const nextMessages = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    try {
      const { data } = await axios.post(
        `${apiBase}/chat`,
        {
          job_id: jobId,
          question: trimmed,
          history: historyTurns,
        },
        { timeout: 30000 }
      );

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer || "No answer returned.",
          sources: Array.isArray(data.sources) ? data.sources : [],
          model: data.model || "",
        },
      ]);
    } catch (err) {
      const status = err?.response?.status;
      const serverMsg = err?.response?.data?.error || err?.response?.data?.message;
      if (status === 429) {
        setErrorBanner(
          "Groq rate limit reached right now. Please wait a few seconds and try your question again."
        );
      } else {
        setErrorBanner(
          serverMsg || "Could not get an answer from the lecture chat endpoint."
        );
      }
      // Restore question into input if failed so user does not lose it
      setMessages(messages);
      setInput(trimmed);
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendQuestion(input);
  };

  return (
    <section
      aria-label="Chat with this lecture"
      className="w-full bg-surface-container-lowest rounded-xl border border-outline-variant/60 shadow-sm overflow-hidden flex flex-col"
    >
      {/* Header */}
      <div className="bg-surface-container-low px-space-md sm:px-space-lg py-space-md border-b border-outline-variant/40 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-space-sm">
          <span className="material-symbols-outlined text-primary text-[22px]">
            forum
          </span>
          <div>
            <h3 className="font-headline-sm text-base sm:text-headline-sm text-on-surface font-semibold">
              Chat With This Lecture
            </h3>
            <p className="font-code text-xs text-on-surface-variant">
              Answers grounded strictly in retrieved lecture excerpts
            </p>
          </div>
        </div>

        <span
          className={`px-2.5 py-1 rounded font-code text-[11px] uppercase tracking-wider font-semibold ${
            isReady
              ? "bg-tertiary-fixed text-on-tertiary-fixed"
              : "bg-secondary-container text-on-secondary-fixed-variant"
          }`}
        >
          {isReady ? "Grounded Q&A Ready" : "Locked Until Complete"}
        </span>
      </div>

      {/* Body */}
      <div className="p-space-md sm:p-space-lg space-y-space-md">
        {!isReady && (
          <div className="rounded-lg border border-outline-variant/50 bg-surface-container px-3.5 py-2.5 font-code text-xs text-on-surface-variant flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary">
              lock
            </span>
            <span>
              Chat unlocks automatically once lecture processing and chunk indexing complete.
            </span>
          </div>
        )}

        {/* Suggested Questions */}
        {isReady && suggestedQuestions.length > 0 && (
          <div className="space-y-1.5">
            <p className="font-code text-[11px] uppercase tracking-wider text-on-surface-variant">
              Suggested Questions
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestedQuestions.map((q, idx) => (
                <button
                  key={idx}
                  type="button"
                  disabled={!isReady || sending}
                  onClick={() => sendQuestion(q)}
                  className="text-left px-3 py-1.5 rounded-lg border border-outline-variant/70 bg-surface hover:bg-surface-container text-xs text-on-surface transition-colors cursor-pointer disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="rounded-xl border border-outline-variant/40 bg-surface-container-low/60 p-space-md max-h-[380px] overflow-y-auto space-y-3 min-h-[140px]">
          {messages.length === 0 ? (
            <p className="text-center font-code text-xs text-on-surface-variant py-8">
              {isReady
                ? "Ask anything covered in this lecture transcript, or pick a suggested question above."
                : "Waiting for lecture indexing to finish..."}
            </p>
          ) : (
            messages.map((msg, idx) => {
              const isUser = msg.role === "user";
              const isSourcesOpen = Boolean(expandedSources[idx]);
              const sources = msg.sources || [];

              return (
                <div
                  key={idx}
                  className={`flex flex-col ${
                    isUser ? "items-end" : "items-start"
                  }`}
                >
                  <div
                    className={`max-w-[90%] sm:max-w-[82%] rounded-xl px-4 py-2.5 text-sm ${
                      isUser
                        ? "bg-primary text-on-primary rounded-br-sm"
                        : "bg-surface-container-lowest border border-outline-variant/50 text-on-surface rounded-bl-sm shadow-sm"
                    }`}
                  >
                    {isUser ? (
                      <p className="whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </p>
                    ) : (
                      <div className="markdown-content text-sm">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    )}
                  </div>

                  {!isUser && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-1">
                      {sources.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleSources(idx)}
                          className="font-code text-[11px] text-primary hover:underline flex items-center gap-1 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[14px]">
                            {isSourcesOpen ? "expand_less" : "expand_more"}
                          </span>
                          <span>
                            Sources ({sources.length})
                          </span>
                        </button>
                      )}
                      {msg.model && (
                        <span className="font-code text-[11px] text-on-surface-variant/75">
                          Model: {msg.model}
                        </span>
                      )}
                    </div>
                  )}

                  {!isUser && isSourcesOpen && sources.length > 0 && (
                    <div className="mt-2 w-full max-w-[92%] space-y-1.5 pl-1">
                      {sources.map((src) => (
                        <div
                          key={src.chunk_number}
                          className="rounded-lg border border-outline-variant/40 bg-surface-container px-3 py-2 text-xs text-on-surface-variant"
                        >
                          <span className="font-code font-semibold text-on-surface">
                            [Excerpt {src.chunk_number}]
                          </span>{" "}
                          <span>{src.snippet}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {sending && (
            <div className="flex items-center gap-2 font-code text-xs text-on-surface-variant py-1">
              <span className="material-symbols-outlined text-[16px] text-primary animate-spin">
                sync
              </span>
              <span>Retrieving lecture chunks &amp; answering...</span>
            </div>
          )}
          <div ref={listEndRef} />
        </div>

        {errorBanner && (
          <div
            role="alert"
            className="rounded-lg border border-error bg-error-container/20 px-3.5 py-2.5 text-xs font-code text-error"
          >
            {errorBanner}
          </div>
        )}

        {/* Composer */}
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              maxLength={MAX_QUESTION_CHARS}
              disabled={!isReady || sending}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                isReady
                  ? "Ask a question grounded in this lecture..."
                  : "Chat disabled until processing completes..."
              }
              aria-label="Ask a question about this lecture"
              className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:bg-surface-container disabled:opacity-60"
            />
            {input.length > 400 && (
              <span className="absolute right-2.5 bottom-1 text-[10px] font-code text-on-surface-variant">
                {input.length}/{MAX_QUESTION_CHARS}
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={!isReady || sending || !input.trim()}
            className="px-5 py-2.5 rounded-lg bg-primary text-on-primary hover:bg-inverse-surface font-code text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <span className="material-symbols-outlined text-[16px]">send</span>
            <span>{sending ? "Sending..." : "Send"}</span>
          </button>
        </form>
      </div>
    </section>
  );
}
