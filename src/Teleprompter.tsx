import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Rabbit, Type, Info } from "lucide-react";
import { useEditor, EditorContent, JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { marked } from "marked";

type Sentence = { raw: string; words: { text: string }[] };

// Component to render rich content with word-level tracking for voice mode
interface VoiceModeContentProps {
  content: JSONContent;
  spokenWordCount: number;
  nextUnreadWordRef: React.MutableRefObject<HTMLSpanElement | null>;
  onWordClick?: (wordIndex: number) => void;
}

function VoiceModeContent({
  content,
  spokenWordCount,
  nextUnreadWordRef,
  onWordClick,
}: VoiceModeContentProps) {
  const wordIndexRef = useRef(0);

  // Reset word index on each render
  wordIndexRef.current = 0;

  const renderTextWithWordTracking = (text: string, marks?: JSONContent[]) => {
    const tokens = text.split(/(\s+)/);
    return tokens.map((token, i) => {
      const isWord = /\S/.test(token);
      if (!isWord) {
        return <React.Fragment key={i}>{token}</React.Fragment>;
      }

      const wordIndex = wordIndexRef.current;
      wordIndexRef.current += 1;

      let content: React.ReactNode = token;

      // Apply marks (bold, italic, etc.)
      if (marks) {
        for (const mark of marks) {
          if (mark.type === "bold") {
            content = <strong key={`bold-${i}`}>{content}</strong>;
          } else if (mark.type === "italic") {
            content = <em key={`italic-${i}`}>{content}</em>;
          } else if (mark.type === "strike") {
            content = <s key={`strike-${i}`}>{content}</s>;
          } else if (mark.type === "code") {
            content = (
              <code
                key={`code-${i}`}
                className="bg-neutral-800 px-1.5 py-0.5 rounded text-[0.9em]"
              >
                {content}
              </code>
            );
          }
        }
      }

      const thisWordIndex = wordIndex; // Capture for closure
      return (
        <span
          key={i}
          ref={wordIndex === spokenWordCount ? nextUnreadWordRef : undefined}
          onClick={onWordClick ? () => onWordClick(thisWordIndex) : undefined}
          style={{
            opacity: wordIndex < spokenWordCount ? 0.3 : 1,
            transition: "opacity 0.5s ease-out",
            cursor: onWordClick ? "pointer" : undefined,
          }}
        >
          {content}
        </span>
      );
    });
  };

  const renderNode = (node: JSONContent, index: number): React.ReactNode => {
    if (node.type === "text" && node.text) {
      return (
        <React.Fragment key={index}>
          {renderTextWithWordTracking(
            node.text,
            node.marks as JSONContent[] | undefined,
          )}
        </React.Fragment>
      );
    }

    const children = node.content?.map((child, i) => renderNode(child, i));

    switch (node.type) {
      case "doc":
        return <React.Fragment key={index}>{children}</React.Fragment>;
      case "paragraph":
        return (
          <p key={index} className="mb-4 last:mb-0">
            {children}
          </p>
        );
      case "heading":
        const level = node.attrs?.level || 1;
        const HeadingTag = `h${level}` as keyof JSX.IntrinsicElements;
        const headingClasses =
          level === 1
            ? "text-[1.5em] font-bold mt-6 mb-4 first:mt-0"
            : level === 2
              ? "text-[1.3em] font-bold mt-5 mb-3 first:mt-0"
              : "text-[1.15em] font-bold mt-4 mb-2 first:mt-0";
        return (
          <HeadingTag key={index} className={headingClasses}>
            {children}
          </HeadingTag>
        );
      case "bulletList":
        return (
          <ul key={index} className="pl-6 mb-4 space-y-1 list-disc">
            {children}
          </ul>
        );
      case "orderedList":
        return (
          <ol key={index} className="pl-6 mb-4 space-y-1 list-decimal">
            {children}
          </ol>
        );
      case "listItem":
        return <li key={index}>{children}</li>;
      case "blockquote":
        return (
          <blockquote
            key={index}
            className="pl-4 my-4 italic border-l-4 border-neutral-500"
          >
            {children}
          </blockquote>
        );
      case "codeBlock":
        return (
          <pre
            key={index}
            className="bg-neutral-800 p-4 rounded overflow-x-auto mb-4 text-[0.85em]"
          >
            <code>{children}</code>
          </pre>
        );
      case "horizontalRule":
        return <hr key={index} className="my-6 border-neutral-600" />;
      case "hardBreak":
        return <br key={index} />;
      default:
        return <React.Fragment key={index}>{children}</React.Fragment>;
    }
  };

  return <>{renderNode(content, 0)}</>;
}

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
      if (words.length > 0) {
        sentences.push({ raw, words });
      }
    } else if (i % 2 === 1) {
      separators.push(parts[i]);
    }
  }
  // If no sentences were found (no punctuation in text), treat the whole content as one sentence
  if (sentences.length === 0 && trimmed) {
    const words = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => ({ text }));
    if (words.length > 0) {
      sentences.push({ raw: trimmed, words });
    }
  }
  return { sentences, separators };
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\w]/g, "");
}

// Track how many spoken words we've processed (for incremental matching)
let lastProcessedWordCount = 0;

function resetTrackingState() {
  lastProcessedWordCount = 0;
}

/** Check if we have a Deepgram API key configured (local dev) */
const DEEPGRAM_API_KEY_LOCAL = import.meta.env.VITE_DEEPGRAM_API_KEY as
  | string
  | undefined;

/** Check if we're in production (Vercel) - API endpoint will provide the key */
const IS_PRODUCTION = import.meta.env.PROD;

/** Voice is always supported - we'll use API endpoint in prod or local key in dev */
const VOICE_SUPPORTED =
  typeof window !== "undefined" &&
  (IS_PRODUCTION ||
    DEEPGRAM_API_KEY_LOCAL ||
    window.SpeechRecognition != null ||
    window.webkitSpeechRecognition != null);

/** Use Deepgram if we have a local key OR we're in production (API will provide key) */
const USE_DEEPGRAM = !!(DEEPGRAM_API_KEY_LOCAL || IS_PRODUCTION);

/** Default lookahead words for voice matching. */
const DEFAULT_VOICE_LOOKAHEAD_WORDS = 50;
/** Max new words we can mark as spoken in a single recognition result. */
const VOICE_MAX_ADVANCE_PER_RESULT = 30;

export default function Teleprompter() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(50);
  const [fontSize, setFontSize] = useState(() =>
    typeof window !== "undefined" && window.innerWidth >= 768 ? 44 : 24,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [fontFamily, setFontFamily] = useState<"sans" | "serif" | "mono">(
    "sans",
  );
  const [lineHeight, setLineHeight] = useState(1.5);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [mode, setMode] = useState<"auto" | "voice">("auto");
  const [spokenWordCount, setSpokenWordCount] = useState(0); // Display position (animated)
  const [targetWordCount, setTargetWordCount] = useState(0); // Target position (from algorithm)
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [recognizedTranscript, setRecognizedTranscript] = useState("");
  const [showRecognizedSpeech, setShowRecognizedSpeech] = useState(true);
  const [voiceLookahead, setVoiceLookahead] = useState(
    DEFAULT_VOICE_LOOKAHEAD_WORDS,
  );
  const [mobileBottomInset, setMobileBottomInset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Tiptap editor for WYSIWYG markdown editing
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
      }),
      Placeholder.configure({
        placeholder: "Enter or paste your script here...",
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "outline-none min-h-[50vh]",
      },
    },
    editable: !isPlaying,
  });

  // Update editor editability when playing state changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!isPlaying);
    }
  }, [editor, isPlaying]);

  // Extract plain text content from editor for voice mode and other features
  const content = editor?.getText() || "";

  // Get editor's JSON content for rich voice mode rendering
  const editorJsonContent = editor?.getJSON();

  // Drag and drop handlers for markdown files
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isPlaying) {
        setIsDragging(true);
      }
    },
    [isPlaying],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (isPlaying || !editor) return;

      const files = Array.from(e.dataTransfer.files);
      const mdFile = files.find(
        (f) =>
          f.name.endsWith(".md") ||
          f.name.endsWith(".markdown") ||
          f.name.endsWith(".txt"),
      );

      if (mdFile) {
        try {
          const text = await mdFile.text();
          // Convert markdown to HTML and set editor content
          const html = await marked(text);
          editor.commands.setContent(html);
        } catch (err) {
          console.error("Failed to read file:", err);
        }
      }
    },
    [isPlaying, editor],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastAnimationTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const fatalErrorRef = useRef(false);
  const spokenCountRef = useRef(0);
  const nextUnreadWordRef = useRef<HTMLSpanElement | null>(null);
  const recognizedSpeechRef = useRef<HTMLDivElement | null>(null);
  const scriptWordsRef = useRef<string[]>([]);
  const sentenceEndGlobalIndexRef = useRef<number[]>([]);
  const voiceLookaheadRef = useRef(DEFAULT_VOICE_LOOKAHEAD_WORDS);

  // Deepgram refs
  const deepgramSocketRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const deepgramTranscriptRef = useRef<string>("");

  const { sentences } = useMemo(
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
    voiceLookaheadRef.current = voiceLookahead;
  }, [voiceLookahead]);

  // Smooth animation: move spokenWordCount toward targetWordCount
  useEffect(() => {
    if (mode !== "voice" || !isPlaying) {
      // Not in voice mode - sync immediately
      if (spokenWordCount !== targetWordCount) {
        setSpokenWordCount(targetWordCount);
      }
      return;
    }

    const animate = (timestamp: number) => {
      if (!lastAnimationTimeRef.current) {
        lastAnimationTimeRef.current = timestamp;
      }

      const delta = timestamp - lastAnimationTimeRef.current;
      lastAnimationTimeRef.current = timestamp;

      setSpokenWordCount((current) => {
        if (current === targetWordCount) {
          return current;
        }

        // Animation speed: words per second (slower = calmer)
        const wordsPerSecond = 3;
        const wordsThisFrame = (wordsPerSecond * delta) / 1000;

        if (current < targetWordCount) {
          // Moving forward
          const newPos = Math.min(
            current + Math.max(1, wordsThisFrame),
            targetWordCount,
          );
          return Math.round(newPos);
        } else {
          // Moving backward
          const newPos = Math.max(
            current - Math.max(1, wordsThisFrame),
            targetWordCount,
          );
          return Math.round(newPos);
        }
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      lastAnimationTimeRef.current = 0;
    };
  }, [mode, isPlaying, targetWordCount]);

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
    setTargetWordCount(0);
    setRecognizedTranscript("");
    setVoiceError(null);
    resetTrackingState(); // Reset the sequential tracking state
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  };

  // Handle clicking on a word to jump to that position
  const handleWordClick = useCallback((wordIndex: number) => {
    setTargetWordCount(wordIndex);
    setSpokenWordCount(wordIndex);
    spokenCountRef.current = wordIndex;
    resetTrackingState(); // Reset so algorithm doesn't fight the manual jump
  }, []);

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

  // Process transcript and update target position using incremental matching
  const processTranscript = useCallback(
    (transcript: string, isFinal: boolean) => {
      const scriptWords = scriptWordsRef.current;
      const spokenWords = transcript.split(/\s+/).filter(Boolean);

      if (scriptWords.length === 0 || spokenWords.length === 0) return;

      // Normalize words for comparison
      const normalizedScript = scriptWords.map(normalizeWord);
      const normalizedSpoken = spokenWords
        .map(normalizeWord)
        .filter((w) => w.length > 0);

      // Only process NEW words since last call (prevents re-matching)
      const newWordsStart = Math.min(
        lastProcessedWordCount,
        normalizedSpoken.length,
      );
      const newWords = normalizedSpoken.slice(newWordsStart);
      lastProcessedWordCount = normalizedSpoken.length;

      if (newWords.length === 0) return;

      setTargetWordCount((current) => {
        let scriptPos = current;
        const lookAhead = 100;
        const lookBehind = 100;

        // Helper: find longest consecutive match starting at given positions
        const findConsecutiveMatches = (
          spokenStart: number,
          scriptStart: number,
          maxGap: number = 2
        ): { count: number; endPos: number } => {
          let matches = 0;
          let scriptIdx = scriptStart;
          let lastMatchPos = scriptStart;

          for (let i = spokenStart; i < newWords.length && scriptIdx < normalizedScript.length; i++) {
            const word = newWords[i];
            if (word.length <= 2) continue; // Skip tiny words

            // Look for this word within a small gap
            let found = false;
            for (let gap = 0; gap <= maxGap && scriptIdx + gap < normalizedScript.length; gap++) {
              if (normalizedScript[scriptIdx + gap] === word) {
                matches++;
                lastMatchPos = scriptIdx + gap;
                scriptIdx = scriptIdx + gap + 1;
                found = true;
                break;
              }
            }
            if (!found) break; // Sequence broken
          }
          return { count: matches, endPos: lastMatchPos };
        };

        // Check for BACKWARD match
        // First: try single-word matching for long distinctive words
        for (const word of newWords) {
          if (word.length >= 6) { // Only match distinctive words (6+ chars)
            const searchStart = Math.max(0, current - lookBehind);
            // Look backwards from current position
            for (let pos = current - 5; pos >= searchStart; pos--) {
              if (normalizedScript[pos] === word) {
                scriptPos = pos + 1;
                break;
              }
            }
          }
        }

        // Second: consecutive matching for more confident backward jumps
        if (newWords.length >= 2 && scriptPos === current) {
          const searchStart = Math.max(0, current - lookBehind);
          let bestBackwardPos = -1;
          let bestBackwardMatches = 0;

          for (let pos = searchStart; pos < current - 3; pos++) {
            const result = findConsecutiveMatches(0, pos, 2);
            // Need 3+ consecutive matches to go back
            if (result.count >= 3 && result.count > bestBackwardMatches) {
              bestBackwardMatches = result.count;
              bestBackwardPos = result.endPos + 1;
            }
          }

          if (bestBackwardPos >= 0 && bestBackwardPos < current) {
            scriptPos = bestBackwardPos;
          }
        }

        // Check for FORWARD match
        // First: try single-word matching for long distinctive words (immediate response)
        for (const word of newWords) {
          if (word.length >= 6) { // Only match distinctive words (6+ chars)
            // Look in a larger window ahead to allow skipping sentences
            for (let pos = scriptPos; pos < scriptPos + lookAhead && pos < normalizedScript.length; pos++) {
              if (normalizedScript[pos] === word) {
                scriptPos = pos + 1;
                break;
              }
            }
          }
        }

        // Second: consecutive matching for more confident jumps
        if (newWords.length >= 2) {
          let bestForwardPos = scriptPos;
          let bestForwardMatches = 0;

          for (let pos = scriptPos; pos < scriptPos + lookAhead && pos < normalizedScript.length; pos++) {
            const result = findConsecutiveMatches(0, pos, 2);
            // Need 2+ consecutive matches to advance further
            if (result.count >= 2 && result.count > bestForwardMatches) {
              bestForwardMatches = result.count;
              bestForwardPos = result.endPos + 1;
            }
          }

          if (bestForwardMatches >= 2) {
            scriptPos = bestForwardPos;
          }
        }

        // Cap large jumps forward
        const maxAdvance = isFinal ? VOICE_MAX_ADVANCE_PER_RESULT : 15;
        const finalPosition = Math.min(scriptPos, current + maxAdvance);

        spokenCountRef.current = finalPosition;
        return finalPosition;
      });
    },
    [],
  );

  // Deepgram voice recognition
  useEffect(() => {
    if (mode !== "voice" || !isPlaying || !USE_DEEPGRAM) {
      // Cleanup Deepgram if it was running
      if (deepgramSocketRef.current) {
        deepgramSocketRef.current.close();
        deepgramSocketRef.current = null;
      }
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      deepgramTranscriptRef.current = "";
      return;
    }

    console.log("[Deepgram] Starting...");
    let isActive = true;

    const startDeepgram = async () => {
      // Reset tracking state for new session
      resetTrackingState();

      try {
        // Get Deepgram credentials - either from local env or API endpoint
        let apiKey = DEEPGRAM_API_KEY_LOCAL;
        let wsUrl =
          "wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=100&vad_events=true";

        if (!apiKey && IS_PRODUCTION) {
          // Fetch token from our API endpoint
          console.log("[Deepgram] Fetching token from API...");
          try {
            const response = await fetch("/api/deepgram");
            if (!response.ok) {
              const error = await response
                .json()
                .catch(() => ({ error: "Failed to get Deepgram credentials" }));
              throw new Error(
                error.error || "Failed to get Deepgram credentials",
              );
            }
            const data = await response.json();
            apiKey = data.token;
            if (data.url) wsUrl = data.url;
          } catch (fetchErr) {
            console.error("[Deepgram] Failed to fetch token:", fetchErr);
            throw new Error(
              "Could not connect to voice service. Please try again.",
            );
          }
        }

        if (!apiKey) {
          throw new Error("Deepgram API key not configured");
        }

        if (!isActive) return;

        // Get microphone access
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });

        if (!isActive) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        mediaStreamRef.current = stream;

        // Connect to Deepgram WebSocket
        const socket = new WebSocket(wsUrl, ["token", apiKey]);

        socket.onopen = () => {
          console.log("[Deepgram] WebSocket connected");
          if (!isActive) {
            socket.close();
            return;
          }

          deepgramSocketRef.current = socket;
          deepgramTranscriptRef.current = "";

          // Start MediaRecorder to capture audio
          const mediaRecorder = new MediaRecorder(stream, {
            mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
              ? "audio/webm;codecs=opus"
              : "audio/webm",
          });

          mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
              socket.send(event.data);
            }
          };

          mediaRecorder.start(100); // Send data every 100ms
          mediaRecorderRef.current = mediaRecorder;
          console.log("[Deepgram] MediaRecorder started");
        };

        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const isFinal = data.is_final;

            if (transcript) {
              if (isFinal) {
                // Append final transcript
                deepgramTranscriptRef.current += " " + transcript;
                const fullTranscript = deepgramTranscriptRef.current.trim();
                setRecognizedTranscript(fullTranscript);
                processTranscript(fullTranscript, true);
              } else {
                // Show interim result
                const displayTranscript = (
                  deepgramTranscriptRef.current +
                  " " +
                  transcript
                ).trim();
                setRecognizedTranscript(displayTranscript);
                // Also process interim for faster tracking
                processTranscript(displayTranscript, false);
              }
            }
          } catch (e) {
            console.error("[Deepgram] Failed to parse message:", e);
          }
        };

        socket.onerror = (error) => {
          console.error("[Deepgram] WebSocket error:", error);
          setVoiceError("Deepgram connection error. Check your API key.");
          setIsPlaying(false);
        };

        socket.onclose = (event) => {
          console.log("[Deepgram] WebSocket closed", event.code, event.reason);
          if (isActive && event.code !== 1000) {
            // Abnormal closure
            setVoiceError("Deepgram connection closed unexpectedly.");
          }
        };
      } catch (err) {
        console.error("[Deepgram] Setup error:", err);
        if (err instanceof Error && err.name === "NotAllowedError") {
          setVoiceError("Microphone access denied");
        } else {
          setVoiceError(
            err instanceof Error ? err.message : "Could not start microphone",
          );
        }
        setIsPlaying(false);
      }
    };

    startDeepgram();
    setVoiceError(null);

    return () => {
      console.log("[Deepgram] Cleanup");
      isActive = false;
      if (deepgramSocketRef.current) {
        deepgramSocketRef.current.close();
        deepgramSocketRef.current = null;
      }
      if (mediaRecorderRef.current) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          /* ignore */
        }
        mediaRecorderRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
    };
  }, [mode, isPlaying, processTranscript]);

  // Fallback: Browser Speech Recognition (when Deepgram not configured)
  useEffect(() => {
    if (USE_DEEPGRAM) return; // Skip if using Deepgram

    console.log("[Voice] Browser Speech API effect run", {
      mode,
      isPlaying,
      VOICE_SUPPORTED,
      flatWordsLength: flatWords.length,
    });

    if (mode !== "voice" || !isPlaying || !VOICE_SUPPORTED) {
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

    // Reset tracking state for new session
    resetTrackingState();

    const recognition = new SR() as SpeechRecognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;
    fatalErrorRef.current = false;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.length > 0) {
          const text = (r[0] as { transcript: string }).transcript;
          if (r.isFinal) {
            finalTranscript += text + " ";
          } else {
            interimTranscript += text;
          }
        }
      }

      const displayText = (finalTranscript + interimTranscript).trim();
      setRecognizedTranscript(displayText);

      const trackingText = finalTranscript.trim();
      if (trackingText) {
        processTranscript(trackingText, true);
      }
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
          "Speech service unreachable. Consider adding a Deepgram API key for better results.",
        );
        setIsPlaying(false);
      } else if (event.error !== "no-speech") {
        fatalErrorRef.current = true;
        setVoiceError(event.error ?? "Speech recognition error");
        setIsPlaying(false);
      }
    };

    recognition.onend = () => {
      if (fatalErrorRef.current) return;
      if (
        recognitionRef.current === recognition &&
        mode === "voice" &&
        isPlaying
      ) {
        try {
          recognition.start();
        } catch {
          /* ignore */
        }
      }
    };

    setVoiceError(null);
    try {
      recognition.start();
    } catch (e) {
      setVoiceError(
        e instanceof Error ? e.message : "Could not start microphone",
      );
    }

    return () => {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
    };
  }, [mode, isPlaying, flatWords.length, processTranscript]);

  // Smooth scroll with ease-in curve
  const scrollTargetRef = useRef<number | null>(null);
  const scrollStartRef = useRef<number | null>(null);
  const scrollStartTimeRef = useRef<number | null>(null);
  const scrollAnimationRef = useRef<number | null>(null);

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

    // Calculate target scroll position
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const offsetFromTop = cr.height * 0.32;
    const targetScrollTop = Math.max(
      0,
      container.scrollTop + (er.top - cr.top) - offsetFromTop,
    );

    // Set new target and reset animation start
    const currentScroll = container.scrollTop;
    if (scrollTargetRef.current !== targetScrollTop) {
      scrollTargetRef.current = targetScrollTop;
      scrollStartRef.current = currentScroll;
      scrollStartTimeRef.current = null; // Will be set on first frame
    }

    // Start smooth scroll animation if not already running
    if (scrollAnimationRef.current) return;

    const animateScroll = (timestamp: number) => {
      const container = scrollRef.current;
      const target = scrollTargetRef.current;
      const start = scrollStartRef.current;

      if (!container || target === null || start === null) {
        scrollAnimationRef.current = null;
        return;
      }

      // Initialize start time
      if (scrollStartTimeRef.current === null) {
        scrollStartTimeRef.current = timestamp;
      }

      const elapsed = timestamp - scrollStartTimeRef.current;
      const duration = 500; // Animation duration in ms
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out curve: starts fast, slows down at the end
      const easedProgress = 1 - Math.pow(1 - progress, 2);

      // Calculate current position
      const diff = target - start;
      const newScrollTop = start + diff * easedProgress;

      container.scrollTop = newScrollTop;

      // Continue or finish
      if (progress < 1) {
        scrollAnimationRef.current = requestAnimationFrame(animateScroll);
      } else {
        scrollAnimationRef.current = null;
      }
    };

    scrollAnimationRef.current = requestAnimationFrame(animateScroll);

    return () => {
      // Don't cancel - let animation continue smoothly
    };
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
      if (e.code === "Tab" && content) {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "Escape") {
        setShowSettings((prev) => !prev);
      } else if (e.code === "ArrowLeft" && content && isPlaying) {
        e.preventDefault();
        setSpeed((prev) => Math.max(10, prev - 5));
      } else if (e.code === "ArrowRight" && content && isPlaying) {
        e.preventDefault();
        setSpeed((prev) => Math.min(200, prev + 5));
      } else if (e.code === "ArrowUp" && content && isPlaying) {
        e.preventDefault();
        setFontSize((prev) => Math.min(120, prev + 4));
      } else if (e.code === "ArrowDown" && content && isPlaying) {
        e.preventDefault();
        setFontSize((prev) => Math.max(24, prev - 4));
      }
    },
    [content, isPlaying, togglePlay],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyPress as EventListener);
    return () =>
      window.removeEventListener("keydown", handleKeyPress as EventListener);
  }, [handleKeyPress]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      if (window.innerWidth >= 768) {
        setMobileBottomInset(0);
        return;
      }
      const bottom = window.innerHeight - (vv.offsetTop + vv.height);
      const inset = Math.max(0, Math.min(120, Math.round(bottom)));
      setMobileBottomInset(inset);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

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
                <div className="flex flex-col gap-2 md:flex-row md:gap-6 md:justify-between md:items-center">
                  <label className="font-bold text-neutral-300 shrink-0">
                    FONT
                  </label>
                  <span className="flex gap-2 items-center w-full md:w-auto">
                    {(["sans", "serif", "mono"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFontFamily(f)}
                        className={`flex-1 md:flex-initial px-4 py-2 text-sm font-bold capitalize ${fontFamily === f ? "bg-white text-black" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                      >
                        {f}
                      </button>
                    ))}
                  </span>
                </div>

                <div className="flex flex-col gap-2 md:flex-row md:gap-6 md:justify-between md:items-center">
                  <label className="w-32 font-bold text-neutral-300 shrink-0">
                    FONT SIZE
                  </label>
                  <div
                    className="flex flex-row-reverse items-center w-full md:flex-row md:flex-1 md:min-w-0 md:max-w-xs"
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

                <div className="flex flex-col gap-2 md:flex-row md:gap-6 md:justify-between md:items-center">
                  <label className="w-32 font-bold text-neutral-300 shrink-0">
                    LINE HEIGHT
                  </label>
                  <div
                    className="flex flex-row-reverse items-center w-full md:flex-row md:flex-1 md:min-w-0 md:max-w-xs"
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

                {VOICE_SUPPORTED && (
                  <div className="flex flex-col gap-2 md:flex-row md:gap-6 md:justify-between md:items-center">
                    <label className="font-bold text-neutral-300 shrink-0">
                      MODE
                    </label>
                    <span className="flex gap-2 items-center w-full md:w-auto">
                      <button
                        type="button"
                        onClick={() => {
                          setMode("auto");
                          spokenCountRef.current = 0;
                          setSpokenWordCount(0);
                          setTargetWordCount(0);
                          setRecognizedTranscript("");
                        }}
                        className={`flex-1 md:flex-initial px-4 py-2 text-sm font-bold ${mode === "auto" ? "bg-white text-black" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
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
                          setTargetWordCount(0);
                          setRecognizedTranscript("");
                          setVoiceError(null);
                          resetTrackingState();
                        }}
                        className={`flex-1 md:flex-initial px-4 py-2 text-sm font-bold ${mode === "voice" ? "bg-white text-black" : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"}`}
                      >
                        Voice
                      </button>
                    </span>
                  </div>
                )}

                {mode === "auto" && (
                  <div className="flex flex-col gap-2 md:flex-row md:gap-6 md:justify-between md:items-center">
                    <label className="w-32 font-bold text-neutral-300 shrink-0">
                      SPEED
                    </label>
                    <div
                      className="flex flex-row-reverse items-center w-full md:flex-row md:flex-1 md:min-w-0 md:max-w-xs"
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
                )}

                {mode === "voice" && (
                  <>
                    <div className="flex flex-row gap-2 justify-between items-center md:gap-6">
                      <span className="font-bold text-neutral-300 shrink-0">
                        TRANSCRIPT
                      </span>
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
                    <div className="flex flex-col gap-2 md:flex-row md:gap-6 md:justify-between md:items-center">
                      <label className="flex gap-1.5 items-center font-bold text-neutral-300 shrink-0">
                        LOOKAHEAD
                        <span className="relative group">
                          <Info
                            size={16}
                            className="cursor-help text-neutral-500 hover:text-neutral-300"
                          />
                          <span className="absolute bottom-full left-1/2 z-50 px-3 py-2 mb-2 text-sm font-normal whitespace-nowrap rounded shadow-lg opacity-0 transition-opacity -translate-x-1/2 pointer-events-none text-neutral-200 bg-neutral-800 group-hover:opacity-100 group-hover:pointer-events-auto">
                            How many words ahead to search when matching your
                            speech to the script
                          </span>
                        </span>
                      </label>
                      <div
                        className="flex flex-row-reverse items-center w-full md:flex-row md:flex-1 md:min-w-0 md:max-w-xs"
                        style={{ gap: 10 }}
                      >
                        <span className="w-14 tabular-nums text-right text-neutral-300 shrink-0">
                          {voiceLookahead}
                        </span>
                        <input
                          type="range"
                          min="4"
                          max="30"
                          value={voiceLookahead}
                          onChange={(e) =>
                            setVoiceLookahead(Number(e.target.value))
                          }
                          className="flex-1 min-w-0 h-1 appearance-none bg-neutral-600"
                          style={{ accentColor: "#a3a3a3" }}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="px-8 py-6 text-sm text-center shrink-0 text-neutral-400">
            <p className="hidden flex-wrap gap-y-2 gap-x-3 justify-center items-center md:flex">
              <span className="keycap">TAB</span>
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

      <div
        className="flex absolute right-0 bottom-0 left-0 z-10 flex-col"
        style={{
          paddingBottom:
            mobileBottomInset > 0
              ? `calc(${mobileBottomInset}px + env(safe-area-inset-bottom, 0px))`
              : "env(safe-area-inset-bottom, 0px)",
        }}
      >
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
        <div className="relative p-2.5 md:p-5 border-t bg-neutral-900 border-neutral-700">
          <div className="flex justify-center items-center md:justify-between">
            <div className="hidden gap-8 w-52 font-mono text-lg tabular-nums md:flex shrink-0 text-neutral-400">
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

            <div className="flex gap-4 items-center md:absolute md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2">
              <button
                onClick={reset}
                className="flex justify-center items-center w-[44px] h-[44px] text-xl font-bold bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
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
                className="flex justify-center items-center w-[44px] h-[44px] text-xl font-bold text-black bg-white hover:bg-neutral-200"
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
                className="flex justify-center items-center w-[44px] h-[44px] text-xl font-bold bg-neutral-700 text-neutral-200 hover:bg-neutral-600"
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

            <div className="hidden justify-end w-52 font-mono text-lg tabular-nums md:flex shrink-0 text-neutral-400">
              {formatTime(elapsedTime)}
            </div>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="overflow-y-scroll h-screen scrollbar-hide"
        style={{
          paddingBottom: `calc(8rem + ${mobileBottomInset}px)`,
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drop zone indicator */}
        {isDragging && !isPlaying && (
          <div className="flex absolute inset-0 z-50 justify-center items-center bg-black/80">
            <div className="p-8 text-center rounded-lg border-2 border-dashed border-neutral-500">
              <p className="text-2xl font-bold text-neutral-300">
                Drop markdown file here
              </p>
              <p className="mt-2 text-neutral-500">.md, .markdown, or .txt</p>
            </div>
          </div>
        )}
        <div className="px-8 pt-8 pb-32 mx-auto max-w-4xl md:pt-32">
          <div className="relative min-h-[50vh]">
            {/* Voice mode when playing: rich content with word-level fading for tracking */}
            {isPlaying && mode === "voice" && editorJsonContent ? (
              <div
                className={`tiptap-editor text-neutral-100 select-none ${fontFamily === "sans" ? "font-sans" : fontFamily === "serif" ? "font-serif" : "font-mono"}`}
                style={{ fontSize: `${fontSize}px`, lineHeight }}
              >
                <VoiceModeContent
                  content={editorJsonContent}
                  spokenWordCount={spokenWordCount}
                  nextUnreadWordRef={nextUnreadWordRef}
                  onWordClick={handleWordClick}
                />
              </div>
            ) : (
              /* Tiptap editor: WYSIWYG editing when paused, read-only rich display when playing */
              <div
                className={`tiptap-editor text-neutral-100 ${fontFamily === "sans" ? "font-sans" : fontFamily === "serif" ? "font-serif" : "font-mono"} ${isPlaying ? "select-none" : ""}`}
                style={{ fontSize: `${fontSize}px`, lineHeight }}
              >
                <EditorContent editor={editor} />
              </div>
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
