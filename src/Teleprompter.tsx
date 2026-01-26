import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Rabbit, Type } from "lucide-react";

type Sentence = { raw: string; words: { text: string }[] };

function parseContentToSentences(content: string): {
  sentences: Sentence[];
  separators: string[];
} {
  const trimmed = content.trim();
  if (!trimmed) return { sentences: [], separators: [] };
  // Split on sentence-ending punctuation but capture the following whitespace (keeps \n, \n\n, etc.)
  const parts = trimmed.split(/(?<=[.!?])(\s*)/);
  const sentences: Sentence[] = [];
  const separators: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0 && parts[i].length > 0) {
      const raw = parts[i];
      const words = raw
        .split(/\s+/)
        .filter(Boolean)
        .map((text) => ({ text }));
      sentences.push({ raw, words });
    } else if (i % 2 === 1) {
      separators.push(parts[i]);
    }
  }
  return { sentences, separators };
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\w]/g, "");
}

const VOICE_SUPPORTED =
  typeof window !== "undefined" &&
  (window.SpeechRecognition != null || window.webkitSpeechRecognition != null);

/** When matching transcript → script, only look this many words ahead for each transcript word. */
const VOICE_LOOKAHEAD_WORDS = 12;
/** Max new words we can mark as spoken in a single recognition result. */
const VOICE_MAX_ADVANCE_PER_RESULT = 20;

export default function Teleprompter() {
  const [content, setContent] = useState("");
  const [textInput, setTextInput] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(50);
  const [fontSize, setFontSize] = useState(48);
  const [showSettings, setShowSettings] = useState(false);
  const [lineHeight, setLineHeight] = useState(1.5);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [mode, setMode] = useState<"auto" | "voice">("auto");
  const [spokenWordCount, setSpokenWordCount] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [recognizedTranscript, setRecognizedTranscript] = useState("");
  const [showRecognizedSpeech, setShowRecognizedSpeech] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const fatalErrorRef = useRef(false);
  const spokenCountRef = useRef(0);
  const sentenceRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const nextUnreadWordRef = useRef<HTMLSpanElement | null>(null);
  const recognizedSpeechRef = useRef<HTMLDivElement | null>(null);
  const scriptWordsRef = useRef<string[]>([]);
  const sentenceEndGlobalIndexRef = useRef<number[]>([]);

  const { sentences, separators } = useMemo(
    () => parseContentToSentences(content),
    [content],
  );
  const flatWords = useMemo(
    () => sentences.flatMap((s) => s.words.map((w) => w.text)),
    [sentences],
  );
  const sentenceEndGlobalIndices = useMemo(() => {
    const out: number[] = [];
    let idx = 0;
    for (const s of sentences) {
      idx += s.words.length;
      out.push(idx - 1);
    }
    return out;
  }, [sentences]);

  useEffect(() => {
    scriptWordsRef.current = flatWords;
    sentenceEndGlobalIndexRef.current = sentenceEndGlobalIndices;
  }, [flatWords, sentenceEndGlobalIndices]);

  useEffect(() => {
    if (mode !== "auto" || !isPlaying || !scrollRef.current) return;

    const scroll = (timestamp: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = timestamp;
      const delta = timestamp - lastTimeRef.current;

      if (delta > 16 && scrollRef.current) {
        const pixelsPerFrame = (speed / 100) * 2;
        scrollRef.current.scrollTop += pixelsPerFrame;
        lastTimeRef.current = timestamp;
      }

      animationRef.current = requestAnimationFrame(scroll);
    };

    animationRef.current = requestAnimationFrame(scroll);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [mode, isPlaying, speed]);

  const togglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      lastTimeRef.current = 0;
      console.log("[Voice] togglePlay", {
        mode,
        wasPlaying: prev,
        willBePlaying: !prev,
      });
      return !prev;
    });
  }, [mode]);

  const reset = () => {
    setIsPlaying(false);
    setElapsedTime(0);
    spokenCountRef.current = 0;
    setSpokenWordCount(0);
    setRecognizedTranscript("");
    setVoiceError(null);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  };

  useEffect(() => {
    if (isPlaying) {
      timerRef.current = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isPlaying, mode]);

  useEffect(() => {
    console.log("[Voice] effect run", {
      mode,
      isPlaying,
      VOICE_SUPPORTED,
      flatWordsLength: flatWords.length,
    });
    if (
      mode !== "voice" ||
      !isPlaying ||
      !VOICE_SUPPORTED ||
      flatWords.length === 0
    ) {
      console.log("[Voice] skipping start — will stop if was running", {
        mode,
        isPlaying,
        VOICE_SUPPORTED,
        flatWordsLength: flatWords.length,
      });
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
      return;
    }

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) {
      console.warn("[Voice] SpeechRecognition constructor not found");
      return;
    }

    const recognition = new SR() as SpeechRecognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;
    fatalErrorRef.current = false;
    console.log("[Voice] recognition created, starting…", {
      totalWords: flatWords.length,
      sentenceEnds: sentenceEndGlobalIndices,
    });

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const scriptWords = scriptWordsRef.current;
      if (scriptWords.length === 0) return;
      let fullTranscript = "";
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal && r.length > 0) {
          fullTranscript += (r[0] as { transcript: string }).transcript + " ";
        }
      }
      const last = event.results[event.results.length - 1];
      if (last && !last.isFinal && last.length > 0) {
        fullTranscript += (last[0] as { transcript: string }).transcript;
      }
      const text = fullTranscript.trim();
      setRecognizedTranscript(text);
      if (!text) return;
      const spoken = text
        .split(/\s+/)
        .map((w) => normalizeWord(w))
        .filter(Boolean);
      // Always match from the start of the script so the same transcript => same position.
      // Otherwise we'd re-use transcript words (e.g. "The", "the") to match later script
      // words and advance too far. Lookahead limits how far each transcript word can reach.
      let idx = 0;
      for (const word of spoken) {
        const limit = Math.min(scriptWords.length, idx + VOICE_LOOKAHEAD_WORDS);
        let found = -1;
        for (let j = idx; j < limit; j++) {
          if (normalizeWord(scriptWords[j]) === word) {
            found = j;
            break;
          }
        }
        if (found >= 0) idx = found + 1;
      }
      setSpokenWordCount((current) => {
        const capped = Math.min(idx, current + VOICE_MAX_ADVANCE_PER_RESULT);
        spokenCountRef.current = capped;
        console.log("[Voice] onresult", {
          transcript: text.slice(0, 60),
          spokenTokens: spoken.length,
          rawMatched: idx,
          capped,
          startIdx: current,
        });
        return capped;
      });
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.log("[Voice] onerror", {
        error: event.error,
        message: event.message,
      });
      if (event.error === "not-allowed") {
        setVoiceError("Microphone access denied");
        setIsPlaying(false);
      } else if (event.error === "network") {
        fatalErrorRef.current = true;
        setVoiceError(
          "Speech service unreachable. This often means an ad blocker or privacy extension is blocking it. Try a private window, disable extensions, or use another browser (e.g. Safari uses on-device recognition).",
        );
        setIsPlaying(false);
      } else if (event.error === "no-speech") {
        /* ignore — safe to restart on onend */
      } else {
        fatalErrorRef.current = true;
        setVoiceError(event.error ?? "Speech recognition error");
        setIsPlaying(false);
      }
    };

    recognition.onend = () => {
      console.log("[Voice] onend", {
        stillActive: recognitionRef.current === recognition,
        hadFatalError: fatalErrorRef.current,
      });
      if (fatalErrorRef.current) return;
      if (
        recognitionRef.current === recognition &&
        mode === "voice" &&
        isPlaying
      ) {
        try {
          recognition.start();
          console.log("[Voice] restarted after onend");
        } catch {
          /* ignore */
        }
      }
    };

    setVoiceError(null);
    try {
      recognition.start();
      console.log("[Voice] recognition.start() called");
    } catch (e) {
      console.error("[Voice] recognition.start() threw", e);
      setVoiceError(
        e instanceof Error ? e.message : "Could not start microphone",
      );
    }

    return () => {
      console.log("[Voice] cleanup — stopping recognition");
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
    };
  }, [mode, isPlaying, flatWords.length]);

  useEffect(() => {
    if (
      mode !== "voice" ||
      flatWords.length === 0 ||
      spokenWordCount >= flatWords.length
    )
      return;
    const container = scrollRef.current;
    const el = nextUnreadWordRef.current;
    if (!container || !el) return;
    const timer = requestAnimationFrame(() => {
      const cr = container.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const offsetFromTop = cr.height * 0.32;
      const targetScrollTop =
        container.scrollTop + (er.top - cr.top) - offsetFromTop;
      container.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(timer);
  }, [mode, spokenWordCount, flatWords.length]);

  useEffect(() => {
    const el = recognizedSpeechRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [recognizedTranscript]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleKeyPress = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === "Space" && content) {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "Escape") {
        setShowSettings((prev) => !prev);
      } else if (e.code === "ArrowLeft" && content) {
        e.preventDefault();
        setSpeed((prev) => Math.max(10, prev - 5));
      } else if (e.code === "ArrowRight" && content) {
        e.preventDefault();
        setSpeed((prev) => Math.min(200, prev + 5));
      } else if (e.code === "ArrowUp" && content) {
        e.preventDefault();
        setFontSize((prev) => Math.min(120, prev + 4));
      } else if (e.code === "ArrowDown" && content) {
        e.preventDefault();
        setFontSize((prev) => Math.max(24, prev - 4));
      }
    },
    [content, togglePlay],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyPress as EventListener);
    return () =>
      window.removeEventListener("keydown", handleKeyPress as EventListener);
  }, [handleKeyPress]);

  const loadContent = () => {
    if (textInput.trim()) {
      setContent(textInput);
      spokenCountRef.current = 0;
      setSpokenWordCount(0);
      setShowSettings(false);
    }
  };

  if (!content) {
    return (
      <div className="flex justify-center items-center p-8 min-h-screen bg-neutral-900">
        <div className="w-full max-w-4xl">
          <h1 className="mb-8 text-4xl font-bold text-center text-neutral-100">
            TELEPROMPTER
          </h1>

          <textarea
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Paste your text here..."
            className="px-4 py-3 w-full h-96 text-lg border resize-none bg-neutral-700 text-neutral-100 placeholder-neutral-400 border-neutral-600 focus:outline-none focus:border-neutral-400"
          />

          <button
            onClick={loadContent}
            disabled={!textInput.trim()}
            className="py-4 mt-4 w-full font-bold text-black bg-white disabled:opacity-30 disabled:bg-neutral-600 hover:bg-neutral-100"
          >
            START
          </button>

          <div className="mt-8 text-sm text-center text-neutral-400">
            <p className="flex flex-wrap gap-y-2 gap-x-3 justify-center items-center">
              <span className="keycap">SPACE</span>
              <span> PLAY/PAUSE </span>
              <span className="ml-6 keycap">ESC</span>
              <span> SETTINGS </span>
              <span className="ml-6 keycap keycap--arrow" aria-label="Left">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="9,2 9,10 3,6" />
                </svg>
              </span>
              <span className="keycap keycap--arrow" aria-label="Right">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="3,2 3,10 9,6" />
                </svg>
              </span>
              <span> SPEED </span>
              <span className="ml-6 keycap keycap--arrow" aria-label="Up">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="6,2 2,10 10,10" />
                </svg>
              </span>
              <span className="keycap keycap--arrow" aria-label="Down">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="6,10 2,2 10,2" />
                </svg>
              </span>
              <span> FONT SIZE</span>
            </p>
          </div>
          <p className="mt-12 text-sm text-center text-neutral-500">
            Created by{" "}
            <a
              href="https://gabrielvaldivia.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-neutral-400 hover:text-neutral-300"
            >
              Gabriel Valdivia
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden relative min-h-screen bg-black">
      {showSettings && (
        <div className="flex fixed inset-0 z-20 flex-col bg-neutral-900">
          <header className="flex justify-between items-center px-8 py-6 border-b shrink-0 border-neutral-700">
            <h2 className="text-2xl font-bold text-neutral-100">SETTINGS</h2>
            <button
              onClick={() => setShowSettings(false)}
              className="text-3xl leading-none text-neutral-400 hover:text-neutral-100"
              aria-label="Close settings"
            >
              ×
            </button>
          </header>
          <div className="overflow-y-auto flex-1">
            <div className="px-8 py-8 mx-auto space-y-6 max-w-4xl">
              <div className="space-y-6">
                {VOICE_SUPPORTED && (
                  <div className="flex gap-6 justify-between items-center">
                    <label className="font-bold text-neutral-300 shrink-0">
                      MODE
                    </label>
                    <span className="flex gap-2 items-center">
                      <button
                        type="button"
                        onClick={() => {
                          setMode("auto");
                          spokenCountRef.current = 0;
                          setSpokenWordCount(0);
                          setRecognizedTranscript("");
                        }}
                        className={`px-4 py-2 text-sm font-bold ${mode === "auto" ? "bg-white text-black" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                      >
                        Auto
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMode("voice");
                          setIsPlaying(false);
                          spokenCountRef.current = 0;
                          setSpokenWordCount(0);
                          setRecognizedTranscript("");
                          setVoiceError(null);
                        }}
                        className={`px-4 py-2 text-sm font-bold ${mode === "voice" ? "bg-white text-black" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                      >
                        Voice
                      </button>
                    </span>
                  </div>
                )}

                {mode === "voice" && (
                  <div className="flex gap-6 justify-between items-center">
                    <label
                      className="font-bold text-neutral-300 shrink-0"
                      htmlFor="show-recognized-speech"
                    >
                      TRANSCRIPT
                    </label>
                    <button
                      type="button"
                      id="show-recognized-speech"
                      role="switch"
                      aria-checked={showRecognizedSpeech}
                      onClick={() => setShowRecognizedSpeech((v) => !v)}
                      className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${showRecognizedSpeech ? "bg-white" : "bg-neutral-600"}`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 shrink-0 rounded-full bg-neutral-900 ring-0 transition-transform ${showRecognizedSpeech ? "translate-x-6" : "translate-x-1"}`}
                      />
                    </button>
                  </div>
                )}

                <div className="flex gap-6 justify-between items-center">
                  <label className="w-32 font-bold text-neutral-300 shrink-0">
                    SPEED
                  </label>
                  <div
                    className="flex flex-1 items-center min-w-0 max-w-xs"
                    style={{ gap: 10 }}
                  >
                    <span className="w-14 tabular-nums text-right text-neutral-300 shrink-0">
                      {speed}%
                    </span>
                    <input
                      type="range"
                      min="10"
                      max="200"
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                      className="flex-1 min-w-0 h-1 appearance-none bg-neutral-600"
                      style={{ accentColor: "#a3a3a3" }}
                    />
                  </div>
                </div>

                <div className="flex gap-6 justify-between items-center">
                  <label className="w-32 font-bold text-neutral-300 shrink-0">
                    FONT SIZE
                  </label>
                  <div
                    className="flex flex-1 items-center min-w-0 max-w-xs"
                    style={{ gap: 10 }}
                  >
                    <span className="w-14 tabular-nums text-right text-neutral-300 shrink-0">
                      {fontSize}px
                    </span>
                    <input
                      type="range"
                      min="24"
                      max="120"
                      value={fontSize}
                      onChange={(e) => setFontSize(Number(e.target.value))}
                      className="flex-1 min-w-0 h-1 appearance-none bg-neutral-600"
                      style={{ accentColor: "#a3a3a3" }}
                    />
                  </div>
                </div>

                <div className="flex gap-6 justify-between items-center">
                  <label className="w-32 font-bold text-neutral-300 shrink-0">
                    LINE HEIGHT
                  </label>
                  <div
                    className="flex flex-1 items-center min-w-0 max-w-xs"
                    style={{ gap: 10 }}
                  >
                    <span className="w-14 tabular-nums text-right text-neutral-300 shrink-0">
                      {lineHeight}
                    </span>
                    <input
                      type="range"
                      min="1"
                      max="2.5"
                      step="0.1"
                      value={lineHeight}
                      onChange={(e) => setLineHeight(Number(e.target.value))}
                      className="flex-1 min-w-0 h-1 appearance-none bg-neutral-600"
                      style={{ accentColor: "#a3a3a3" }}
                    />
                  </div>
                </div>
              </div>

              <button
                onClick={() => {
                  setContent("");
                  setTextInput("");
                  setShowSettings(false);
                }}
                className="px-6 py-2 mt-4 font-bold bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
              >
                NEW TEXT
              </button>
            </div>
          </div>
          <div className="px-8 py-6 text-sm text-center shrink-0 text-neutral-400">
            <p className="flex flex-wrap gap-y-2 gap-x-3 justify-center items-center">
              <span className="keycap">SPACE</span>
              <span> PLAY/PAUSE </span>
              <span className="ml-6 keycap">ESC</span>
              <span> SETTINGS </span>
              <span className="ml-6 keycap keycap--arrow" aria-label="Left">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="9,2 9,10 3,6" />
                </svg>
              </span>
              <span className="keycap keycap--arrow" aria-label="Right">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="3,2 3,10 9,6" />
                </svg>
              </span>
              <span> SPEED </span>
              <span className="ml-6 keycap keycap--arrow" aria-label="Up">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="6,2 2,10 10,10" />
                </svg>
              </span>
              <span className="keycap keycap--arrow" aria-label="Down">
                <svg
                  viewBox="0 0 12 12"
                  className="keycap-arrow-svg"
                  fill="currentColor"
                >
                  <polygon points="6,10 2,2 10,2" />
                </svg>
              </span>
              <span> FONT SIZE</span>
            </p>
            <p className="mt-[20px] text-neutral-500">
              Created by{" "}
              <a
                href="https://gabrielvaldivia.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-neutral-400 hover:text-neutral-300"
              >
                Gabriel Valdivia
              </a>
            </p>
          </div>
        </div>
      )}

      {voiceError && (
        <div className="flex absolute top-4 left-1/2 z-30 gap-2 items-center px-4 py-2 text-sm font-medium text-white rounded -translate-x-1/2 bg-red-900/90">
          <span>{voiceError}</span>
          <button
            type="button"
            onClick={() => setVoiceError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex absolute right-0 bottom-0 left-0 z-10 flex-col">
        {mode === "voice" && showRecognizedSpeech && (
          <div className="px-4 py-2 border-t bg-neutral-800 border-neutral-700">
            <div
              ref={recognizedSpeechRef}
              className="overflow-y-auto text-neutral-200 font-mono text-sm min-h-[1.5rem] max-h-[2.8rem] break-words"
            >
              {recognizedTranscript || "—"}
            </div>
          </div>
        )}
        <div className="relative px-8 py-9 border-t bg-neutral-900 border-neutral-700">
          <div className="flex justify-between items-center">
            <div className="flex gap-8 w-52 font-mono text-lg tabular-nums shrink-0 text-neutral-400">
              <span className="flex gap-1.5 items-center w-[4.5rem]">
                <Rabbit
                  className="shrink-0 text-neutral-500"
                  size={20}
                  aria-hidden
                />
                {speed}%
              </span>
              <span className="flex gap-1.5 items-center w-[5rem]">
                <Type
                  className="shrink-0 text-neutral-500"
                  size={20}
                  aria-hidden
                />
                {fontSize}px
              </span>
            </div>

            <div className="flex absolute top-1/2 left-1/2 gap-4 items-center -translate-x-1/2 -translate-y-1/2">
              <button
                onClick={reset}
                className="flex justify-center items-center w-16 h-16 text-xl font-bold bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                </svg>
              </button>

              <button
                onClick={togglePlay}
                className="flex justify-center items-center w-16 h-16 text-xl font-bold text-black bg-white hover:bg-neutral-200"
              >
                {isPlaying ? (
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => setShowSettings(!showSettings)}
                className="flex justify-center items-center w-16 h-16 text-xl font-bold bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66Z" />
                </svg>
              </button>
            </div>

            <div className="flex justify-end w-52 font-mono text-lg tabular-nums shrink-0 text-neutral-400">
              {formatTime(elapsedTime)}
            </div>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="overflow-y-scroll pb-32 h-screen scrollbar-hide"
      >
        <div className="px-8 pt-32 mx-auto max-w-4xl">
          <div
            className="font-sans whitespace-pre-wrap text-neutral-100"
            style={{
              fontSize: `${fontSize}px`,
              lineHeight: lineHeight,
            }}
          >
            {mode === "voice" && sentences.length > 0 ? (
              <>
                {sentences.map((sentence, si) => {
                  let globalIdx = 0;
                  for (let i = 0; i < si; i++)
                    globalIdx += sentences[i].words.length;
                  const tokens = sentence.raw.split(/(\s+)/);
                  let wordIdx = 0;
                  return (
                    <span
                      key={si}
                      ref={(el) => {
                        sentenceRefs.current[si] = el;
                      }}
                      style={{ display: "inline" }}
                    >
                      {tokens.map((token, ti) => {
                        const isWord = /\S/.test(token);
                        const g = globalIdx + wordIdx;
                        if (isWord) wordIdx += 1;
                        return isWord ? (
                          <span
                            key={`${si}-${ti}`}
                            ref={
                              g === spokenWordCount
                                ? nextUnreadWordRef
                                : undefined
                            }
                            style={{ opacity: g < spokenWordCount ? 0.2 : 1 }}
                            aria-hidden
                          >
                            {token}
                          </span>
                        ) : (
                          <span key={`${si}-${ti}`}>{token}</span>
                        );
                      })}
                      {separators[si] != null ? separators[si] : null}
                    </span>
                  );
                })}
              </>
            ) : (
              content
            )}
          </div>
          {mode === "voice" && content && (
            <div className="min-h-[100vh] shrink-0" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}
